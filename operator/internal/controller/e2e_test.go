//go:build e2e

package controller

// End to end: a real kube-apiserver (envtest), the real CRD, and a real hub started by
// `scripts/e2e-seed.ts` at the repo root. Run with:
//
//	E2E_DIR=<dir the seed script wrote> KUBEBUILDER_ASSETS=<envtest path> go test -tags e2e ./internal/controller -run E2E -v

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
)

func TestE2E(t *testing.T) {
	dir := os.Getenv("E2E_DIR")
	if dir == "" {
		t.Skip("E2E_DIR not set")
	}
	token, _ := os.ReadFile(filepath.Join(dir, "token"))
	var ready struct {
		Project, Env string
		Values       map[string]string
		Origin       string
	}
	b, _ := os.ReadFile(filepath.Join(dir, "ready"))
	_ = json.Unmarshal(b, &ready)
	fp, _ := os.ReadFile(filepath.Join(dir, "fingerprint.txt"))

	te := &envtest.Environment{CRDDirectoryPaths: []string{"../../config/crd"}, ErrorIfCRDPathMissing: true}
	cfg, err := te.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer te.Stop()

	sch := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(sch)
	_ = v1.AddToScheme(sch)
	c, err := client.New(cfg, client.Options{Scheme: sch})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(c.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "prod"}}))
	must(c.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "envvault-token", Namespace: "prod"}, Data: map[string][]byte{"token": token}}))
	replicas := int32(1)
	must(c.Create(ctx, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "prod"},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"a": "b"}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"a": "b"}},
				Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "x"}}},
			},
		},
	}))

	cr := &v1.EnvVaultSecret{
		ObjectMeta: metav1.ObjectMeta{Name: "my-app", Namespace: "prod"},
		Spec: v1.EnvVaultSecretSpec{
			TokenSecretRef: v1.SecretKeyRef{Name: "envvault-token"},
			Project:        ready.Project,
			Environment:    ready.Env,
			Hub:            v1.HubSpec{Fingerprint: strings.TrimSpace(string(fp))},
			RestartOn:      []v1.WorkloadRef{{Kind: "Deployment", Name: "web"}},
		},
	}
	must(c.Create(ctx, cr)) // also proves the CRD schema accepts it

	r := &Reconciler{Client: c, APIReader: c, Scheme: sch}
	key := types.NamespacedName{Namespace: "prod", Name: "my-app"}
	_, err = r.Reconcile(ctx, reqFor(key))
	must(err)

	var got v1.EnvVaultSecret
	must(c.Get(ctx, key, &got))
	cond := meta.FindStatusCondition(got.Status.Conditions, condReady)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("not ready: %+v", cond)
	}
	var s corev1.Secret
	must(c.Get(ctx, key, &s))
	for k, want := range ready.Values {
		if string(s.Data[k]) != want {
			t.Errorf("%s differs", k)
		}
	}
	var dep appsv1.Deployment
	must(c.Get(ctx, types.NamespacedName{Namespace: "prod", Name: "web"}, &dep))
	if dep.Spec.Template.Annotations[annRolled] == "" {
		t.Error("deployment not rolled")
	}
	if got.Status.TokenExpiresAt == nil || time.Until(got.Status.TokenExpiresAt.Time) < 24*time.Hour {
		t.Errorf("the real hub should report the token's expiry, got %v", got.Status.TokenExpiresAt)
	}
	t.Logf("synced %d keys from the real hub; version %s", got.Status.KeyCount, got.Status.ObservedVersion)

	// A wrong pin must be refused and must not touch the Secret.
	got.Spec.Hub.Fingerprint = strings.Repeat("ab", 32)
	must(c.Update(ctx, &got))
	_, err = r.Reconcile(ctx, reqFor(key))
	must(err)
	must(c.Get(ctx, key, &got))
	if cond := meta.FindStatusCondition(got.Status.Conditions, condReady); cond == nil || cond.Reason != reasonHubError {
		t.Fatalf("wrong pin: %+v", cond)
	}
}

// TestE2EPush writes to the real hub with a Go-sealed payload and checks the hub accepted it.
// Reading it back with the TypeScript client is done by the caller (`e2e-driver.ts get`).
//
//	E2E_PUSH_TOKEN=<file with a write token> E2E_PUSH_PROJECT=<project> E2E_PUSH_FP=<fingerprint file>
func TestE2EPush(t *testing.T) {
	tokFile, project := os.Getenv("E2E_PUSH_TOKEN"), os.Getenv("E2E_PUSH_PROJECT")
	if tokFile == "" || project == "" {
		t.Skip("E2E_PUSH_TOKEN / E2E_PUSH_PROJECT not set")
	}
	token, _ := os.ReadFile(tokFile)
	fp, _ := os.ReadFile(os.Getenv("E2E_PUSH_FP"))

	te := &envtest.Environment{CRDDirectoryPaths: []string{"../../config/crd"}, ErrorIfCRDPathMissing: true}
	cfg, err := te.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer te.Stop()
	sch := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(sch)
	_ = v1.AddToScheme(sch)
	c, err := client.New(cfg, client.Options{Scheme: sch})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(c.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "prod"}}))
	must(c.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "envvault-token", Namespace: "prod"}, Data: map[string][]byte{"token": token}}))
	must(c.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "app-config", Namespace: "prod"}, Data: map[string][]byte{
		"PUSHED":    []byte("from-the-cluster"),
		"MULTILINE": []byte("line1\nline2 <&> \"q\" héllo ✓"),
	}}))
	must(c.Create(ctx, &v1.EnvVaultPush{
		ObjectMeta: metav1.ObjectMeta{Name: "push", Namespace: "prod"},
		Spec: v1.EnvVaultPushSpec{
			TokenSecretRef: v1.SecretKeyRef{Name: "envvault-token"}, Project: project, Environment: "default",
			SourceSecretName: "app-config", Hub: v1.HubSpec{Fingerprint: strings.TrimSpace(string(fp))},
		},
	})) // also proves the CRD schema accepts it

	p := &PushReconciler{R: &Reconciler{Client: c, APIReader: c, Scheme: sch}}
	key := types.NamespacedName{Namespace: "prod", Name: "push"}
	_, err = p.Reconcile(ctx, reqFor(key))
	must(err)
	var got v1.EnvVaultPush
	must(c.Get(ctx, key, &got))
	cond := meta.FindStatusCondition(got.Status.Conditions, condReady)
	if cond == nil || cond.Status != metav1.ConditionTrue || got.Status.LastPushTime == nil {
		t.Fatalf("not pushed: %+v", cond)
	}
	t.Logf("pushed %d keys to the real hub; version %s", got.Status.KeyCount, got.Status.ObservedVersion)
}

// TestE2EPushWatch runs the real manager (same cache rules as cmd/main.go) with a one-hour interval,
// so a quick push can only come from the watch on the source Secret.
func TestE2EPushWatch(t *testing.T) {
	tokFile, project := os.Getenv("E2E_PUSH_TOKEN"), os.Getenv("E2E_PUSH_PROJECT")
	if tokFile == "" || project == "" {
		t.Skip("E2E_PUSH_TOKEN / E2E_PUSH_PROJECT not set")
	}
	token, _ := os.ReadFile(tokFile)
	fp, _ := os.ReadFile(os.Getenv("E2E_PUSH_FP"))

	te := &envtest.Environment{CRDDirectoryPaths: []string{"../../config/crd"}, ErrorIfCRDPathMissing: true}
	cfg, err := te.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer te.Stop()
	sch := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(sch)
	_ = v1.AddToScheme(sch)
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:  sch,
		Metrics: metricsserver.Options{BindAddress: "0"},
		Cache:   cache.Options{ByObject: map[client.Object]cache.ByObject{&corev1.Secret{}: {Label: SecretSelector()}, &corev1.ConfigMap{}: {Label: ConfigMapSelector()}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := &Reconciler{Client: mgr.GetClient(), APIReader: mgr.GetAPIReader(), Scheme: mgr.GetScheme(), Concurrency: 2}
	if err := rec.SetupWithManager(mgr); err != nil {
		t.Fatal(err)
	}
	if err := (&PushReconciler{R: rec}).SetupWithManager(mgr); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = mgr.Start(ctx) }()

	c := mgr.GetClient()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(c.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "prod"}}))
	must(c.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "envvault-token", Namespace: "prod"}, Data: map[string][]byte{"token": token}}))
	must(c.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "app-config", Namespace: "prod"}, Data: map[string][]byte{"WATCHED": []byte("one")}}))
	hour := metav1.Duration{Duration: time.Hour}
	must(c.Create(ctx, &v1.EnvVaultPush{
		ObjectMeta: metav1.ObjectMeta{Name: "push", Namespace: "prod"},
		Spec: v1.EnvVaultPushSpec{
			TokenSecretRef: v1.SecretKeyRef{Name: "envvault-token"}, Project: project, Environment: "default",
			SourceSecretName: "app-config", RefreshInterval: &hour, Hub: v1.HubSpec{Fingerprint: strings.TrimSpace(string(fp))},
		},
	}))
	key := types.NamespacedName{Namespace: "prod", Name: "push"}
	version := func() string {
		var got v1.EnvVaultPush
		_ = c.Get(ctx, key, &got)
		return got.Status.ObservedVersion
	}
	waitChange := func(from string) string {
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			if v := version(); v != "" && v != from {
				return v
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("no push within 15s (interval is 1h, so only the watch could have done it)")
		return ""
	}
	first := waitChange("")
	started := time.Now()
	var src corev1.Secret
	must(c.Get(ctx, types.NamespacedName{Namespace: "prod", Name: "app-config"}, &src))
	if src.Labels[ManagedByLabel] != PushSourceValue {
		t.Fatalf("source was not labelled: %v", src.Labels)
	}
	src.Data["WATCHED"] = []byte("two")
	must(c.Update(ctx, &src))
	waitChange(first)
	t.Logf("an edit to the Secret reached the hub in %s with a 1h interval", time.Since(started).Round(10*time.Millisecond))
}
