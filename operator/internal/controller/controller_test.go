package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

type vectors struct {
	ServiceToken string `json:"serviceToken"`
	TokenFields  struct {
		T string `json:"t"`
	} `json:"tokenFields"`
	Environment struct {
		Project       string            `json:"project"`
		Name          string            `json:"name"`
		TenantID      string            `json:"tenantId"`
		WrappedEnvDek string            `json:"wrappedEnvDek"`
		Payload       vault.SealedBox   `json:"payload"`
		Expected      map[string]string `json:"expected"`
	} `json:"environment"`
}

type hub struct {
	srv       *httptest.Server
	updatedAt atomic.Value
	status    atomic.Int32 // non-zero forces this HTTP status
	getEnvs   atomic.Int32
}

func newHub(t *testing.T, v vectors) *hub {
	h := &hub{}
	h.updatedAt.Store("2026-01-01T00:00:00Z")
	e := v.Environment
	h.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s := int(h.status.Load()); s != 0 {
			w.WriteHeader(s)
			_, _ = w.Write([]byte(`{"json":{"code":"UNAUTHORIZED","status":401,"message":"no"}}`))
			return
		}
		var in struct {
			JSON map[string]string `json:"json"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		switch r.URL.Path {
		case "/rpc/environments/list":
			if in.JSON["project"] != e.Project {
				_, _ = w.Write([]byte(`{"json":[]}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"json": []vault.EnvRow{{
				Name: e.Name, UpdatedAt: h.updatedAt.Load().(string), Level: "read", WrappedEnvDek: e.WrappedEnvDek, KeyVersion: 1,
			}}})
		case "/rpc/environments/getEnv":
			h.getEnvs.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"json": vault.EnvPayload{
				TenantID: e.TenantID, ProjectName: e.Project, Name: e.Name, Payload: e.Payload,
			}})
		}
	}))
	t.Cleanup(h.srv.Close)
	return h
}

type env struct {
	r   *Reconciler
	c   client.Client
	hub *hub
	v   vectors
	cr  *v1.EnvVaultSecret
	key types.NamespacedName
}

func setup(t *testing.T, restart ...v1.WorkloadRef) *env {
	t.Helper()
	b, err := os.ReadFile("../../testdata/zk-6.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	h := newHub(t, v)

	sch := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(sch)
	_ = v1.AddToScheme(sch)

	cr := &v1.EnvVaultSecret{
		ObjectMeta: metav1.ObjectMeta{Name: "my-app", Namespace: "prod", UID: "uid-1", Generation: 1},
		Spec: v1.EnvVaultSecretSpec{
			TokenSecretRef: v1.SecretKeyRef{Name: "envvault-token"},
			Project:        v.Environment.Project,
			Environment:    v.Environment.Name,
			Hub:            v1.HubSpec{URL: h.srv.URL, InsecureSkipVerify: true},
			RestartOn:      restart,
		},
	}
	tokenSecret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "envvault-token", Namespace: "prod"},
		Data:       map[string][]byte{"token": []byte(v.ServiceToken)},
	}
	c := fake.NewClientBuilder().WithScheme(sch).WithObjects(cr, tokenSecret).WithStatusSubresource(&v1.EnvVaultSecret{}).Build()
	return &env{
		r: &Reconciler{Client: c, APIReader: c, Scheme: sch},
		c: c, hub: h, v: v, cr: cr,
		key: types.NamespacedName{Namespace: "prod", Name: "my-app"},
	}
}

func (e *env) reconcile(t *testing.T) *v1.EnvVaultSecret {
	t.Helper()
	if _, err := e.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: e.key}); err != nil {
		t.Fatal(err)
	}
	var cr v1.EnvVaultSecret
	if err := e.c.Get(context.Background(), e.key, &cr); err != nil {
		t.Fatal(err)
	}
	return &cr
}

func (e *env) ready(cr *v1.EnvVaultSecret) *metav1.Condition {
	return meta.FindStatusCondition(cr.Status.Conditions, condReady)
}

func (e *env) secret(t *testing.T) *corev1.Secret {
	t.Helper()
	var s corev1.Secret
	if err := e.c.Get(context.Background(), e.key, &s); err != nil {
		t.Fatalf("target secret: %v", err)
	}
	return &s
}

func TestCreatesSecret(t *testing.T) {
	e := setup(t)
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Status != metav1.ConditionTrue {
		t.Fatalf("not ready: %+v", c)
	}
	s := e.secret(t)
	for k, want := range e.v.Environment.Expected {
		if got := string(s.Data[k]); got != want {
			t.Errorf("%s: got %q want %q", k, got, want)
		}
	}
	if s.Labels[ManagedByLabel] != ManagedByValue || len(s.OwnerReferences) != 1 || s.Type != corev1.SecretTypeOpaque {
		t.Errorf("metadata wrong: %+v", s.ObjectMeta)
	}
	if cr.Status.KeyCount != len(e.v.Environment.Expected) || cr.Status.LastSyncTime == nil {
		t.Errorf("status wrong: %+v", cr.Status)
	}
}

func TestStatusNeverHoldsValues(t *testing.T) {
	e := setup(t)
	cr := e.reconcile(t)
	b, _ := json.Marshal(cr.Status)
	for _, v := range e.v.Environment.Expected {
		if v != "" && strings.Contains(string(b), v) {
			t.Fatalf("status leaks a value: %s", b)
		}
	}
}

func TestUnchangedDoesNotDownloadAgain(t *testing.T) {
	e := setup(t)
	e.reconcile(t)
	e.reconcile(t)
	e.reconcile(t)
	if n := e.hub.getEnvs.Load(); n != 1 {
		t.Fatalf("downloaded %d times, want 1", n)
	}
}

func TestRewritesWhenHubVersionChanges(t *testing.T) {
	e := setup(t)
	e.reconcile(t)
	e.hub.updatedAt.Store("2026-02-02T00:00:00Z")
	e.reconcile(t)
	if n := e.hub.getEnvs.Load(); n != 2 {
		t.Fatalf("downloaded %d times, want 2", n)
	}
	if !strings.HasPrefix(e.secret(t).Annotations[annSource], "2026-02-02") {
		t.Error("source version not updated")
	}
}

func TestRepairsDrift(t *testing.T) {
	e := setup(t)
	e.reconcile(t)
	s := e.secret(t)
	s.Data["API_KEY"] = []byte("tampered")
	if err := e.c.Update(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	e.reconcile(t)
	if got := string(e.secret(t).Data["API_KEY"]); got != e.v.Environment.Expected["API_KEY"] {
		t.Fatalf("drift not repaired: %q", got)
	}
}

func TestRefusesToOverwriteForeignSecret(t *testing.T) {
	e := setup(t)
	foreign := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "my-app", Namespace: "prod"}, Data: map[string][]byte{"keep": []byte("me")}}
	if err := e.c.Create(context.Background(), foreign); err != nil {
		t.Fatal(err)
	}
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Reason != reasonConflict {
		t.Fatalf("want conflict, got %+v", c)
	}
	if string(e.secret(t).Data["keep"]) != "me" {
		t.Error("foreign secret was modified")
	}
}

func TestRevokedTokenKeepsExistingSecret(t *testing.T) {
	e := setup(t)
	e.reconcile(t)
	e.hub.status.Store(401)
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Reason != reasonUnauthorized || c.Status != metav1.ConditionFalse {
		t.Fatalf("want unauthorized, got %+v", c)
	}
	if string(e.secret(t).Data["API_KEY"]) != e.v.Environment.Expected["API_KEY"] {
		t.Error("existing secret was removed or changed")
	}
}

func TestUnknownEnvironmentIsNoAccess(t *testing.T) {
	e := setup(t)
	e.cr.Spec.Project = "nope"
	if err := e.c.Update(context.Background(), e.cr); err != nil {
		t.Fatal(err)
	}
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Reason != reasonNoAccess {
		t.Fatalf("want no access, got %+v", c)
	}
}

func TestMissingTokenSecretIsMisconfigured(t *testing.T) {
	e := setup(t)
	_ = e.c.Delete(context.Background(), &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "envvault-token", Namespace: "prod"}})
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Reason != reasonMisconfigured {
		t.Fatalf("want misconfigured, got %+v", c)
	}
}

func TestPlainHTTPHubRefused(t *testing.T) {
	e := setup(t)
	e.cr.Spec.Hub = v1.HubSpec{URL: "http://hub.example:3847"}
	_ = e.c.Update(context.Background(), e.cr)
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Reason != reasonMisconfigured {
		t.Fatalf("want misconfigured, got %+v", c)
	}
}

func TestRollsListedWorkloadsOnce(t *testing.T) {
	e := setup(t, v1.WorkloadRef{Kind: "Deployment", Name: "web"}, v1.WorkloadRef{Kind: "StatefulSet", Name: "absent"})
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "prod"}}
	if err := e.c.Create(context.Background(), dep); err != nil {
		t.Fatal(err)
	}
	e.reconcile(t)
	var got appsv1.Deployment
	_ = e.c.Get(context.Background(), types.NamespacedName{Namespace: "prod", Name: "web"}, &got)
	first := got.Spec.Template.Annotations[annRolled]
	if first == "" {
		t.Fatal("deployment was not rolled")
	}
	e.reconcile(t)
	_ = e.c.Get(context.Background(), types.NamespacedName{Namespace: "prod", Name: "web"}, &got)
	if got.Spec.Template.Annotations[annRolled] != first {
		t.Error("rolled again without a change")
	}
	e.hub.updatedAt.Store("2026-03-03T00:00:00Z")
	e.reconcile(t)
	_ = e.c.Get(context.Background(), types.NamespacedName{Namespace: "prod", Name: "web"}, &got)
	if got.Spec.Template.Annotations[annRolled] == first {
		t.Error("not rolled after a change")
	}
}

func TestInvalidKeys(t *testing.T) {
	bad := invalidKeys(map[string]string{"OK_1": "x", "a-b.c": "x", "has space": "x", "..x": "x", "ünï": "x", ".": "x"})
	if len(bad) != 4 {
		t.Fatalf("got %v", bad)
	}
}

func TestDigestIsStableAndOrderFree(t *testing.T) {
	a := digest(map[string][]byte{"a": []byte("1"), "b": []byte("2")})
	b := digest(map[string][]byte{"b": []byte("2"), "a": []byte("1")})
	if a != b || a == digest(map[string][]byte{"a": []byte("1"), "b": []byte("3")}) {
		t.Fatal("digest not stable or not sensitive")
	}
	// "ab"+"c" must not collide with "a"+"bc"
	if digest(map[string][]byte{"ab": []byte("c")}) == digest(map[string][]byte{"a": []byte("bc")}) {
		t.Fatal("boundary collision")
	}
}

func reqFor(k types.NamespacedName) ctrl.Request { return ctrl.Request{NamespacedName: k} }

// staleCache hides every Secret from cached reads, as an informer that hasn't caught up would.
type staleCache struct{ client.Client }

func (s staleCache) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, ok := obj.(*corev1.Secret); ok && key.Name == "my-app" {
		return apierrors.NewNotFound(schema.GroupResource{Resource: "secrets"}, key.Name)
	}
	return s.Client.Get(ctx, key, obj, opts...)
}

func TestOwnSecretMissingFromCacheIsNotAConflict(t *testing.T) {
	e := setup(t)
	e.reconcile(t) // writes the Secret
	e.r.Client = staleCache{e.c}
	cr := e.reconcile(t) // cache says "not found"; create says "already exists"
	if c := e.ready(cr); c == nil || c.Status != metav1.ConditionTrue {
		t.Fatalf("a stale cache must not look like a conflict: %+v", c)
	}
}

func TestForeignSecretMissingFromCacheIsStillAConflict(t *testing.T) {
	e := setup(t)
	foreign := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "my-app", Namespace: "prod"}, Data: map[string][]byte{"keep": []byte("me")}}
	if err := e.c.Create(context.Background(), foreign); err != nil {
		t.Fatal(err)
	}
	e.r.Client = staleCache{e.c}
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Reason != reasonConflict {
		t.Fatalf("want conflict, got %+v", c)
	}
	if string(e.secret(t).Data["keep"]) != "me" {
		t.Error("foreign secret was modified")
	}
}

func TestClientCacheReusesAndSeparates(t *testing.T) {
	var cc clientCache
	a, err := cc.get("https://hub:1", "tok-a", vault.TLSOptions{})
	if err != nil {
		t.Fatal(err)
	}
	a2, _ := cc.get("https://hub:1", "tok-a", vault.TLSOptions{})
	b, _ := cc.get("https://hub:1", "tok-b", vault.TLSOptions{})
	c, _ := cc.get("https://hub:1", "tok-a", vault.TLSOptions{Fingerprint: strings.Repeat("ab", 32)})
	if a != a2 {
		t.Error("same hub, token and trust must share a client")
	}
	if a == b || a == c {
		t.Error("a different token or trust setting must not share a client")
	}
	if _, err := cc.get("https://hub:1", "tok-a", vault.TLSOptions{Fingerprint: "nope"}); err == nil {
		t.Error("an invalid fingerprint must be refused")
	}
}

func TestClientCacheDropsIdleClients(t *testing.T) {
	var cc clientCache
	old, _ := cc.get("https://hub:1", "old", vault.TLSOptions{})
	for _, e := range cc.m {
		e.used = time.Now().Add(-2 * clientIdle)
	}
	cc.get("https://hub:1", "new", vault.TLSOptions{})
	if len(cc.m) != 1 {
		t.Fatalf("idle client not dropped: %d entries", len(cc.m))
	}
	if again, _ := cc.get("https://hub:1", "old", vault.TLSOptions{}); again == old {
		t.Error("a dropped client must be rebuilt")
	}
}

func TestHangingHubDoesNotBlockOtherReconciles(t *testing.T) {
	// Reconciles against a hub that never answers must not hold anything a healthy one needs (e.g. a lock).
	e := setup(t)
	block := make(chan struct{})
	slow := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-block }))
	defer slow.Close()
	defer close(block)
	e.r.Concurrency = 4
	for i := 0; i < 4; i++ {
		cr := e.cr.DeepCopy()
		cr.ResourceVersion, cr.UID = "", types.UID("u"+string(rune('a'+i)))
		cr.Name = "slow" + string(rune('a'+i))
		cr.Spec.Hub.URL = slow.URL
		if err := e.c.Create(context.Background(), cr); err != nil {
			t.Fatal(err)
		}
	}
	// Reconcile the slow ones in the background (each blocks), then a healthy one must still finish.
	for i := 0; i < 4; i++ {
		name := "slow" + string(rune('a'+i))
		go e.r.Reconcile(context.Background(), reqFor(types.NamespacedName{Namespace: "prod", Name: name}))
	}
	done := make(chan struct{})
	go func() { e.reconcile(t); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a healthy resource was held up by hubs that never answer")
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	iv := 10 * time.Second
	want := []time.Duration{iv, iv, 2 * iv, 4 * iv, 8 * iv, 16 * iv, maxBackoff} // 32*iv=320s is capped to 5m
	for i, w := range want {
		if got := backoff(iv, i); got != w {
			t.Errorf("failures=%d: got %v want %v", i, got, w)
		}
	}
	if got := backoff(iv, 50); got != maxBackoff {
		t.Errorf("not capped: %v", got)
	}
	if got := backoff(10*time.Minute, 5); got != 10*time.Minute {
		t.Errorf("a long interval must never shrink: %v", got)
	}
}

func TestFailuresCountThenResetOnSuccess(t *testing.T) {
	e := setup(t)
	e.hub.status.Store(401)
	for i := 1; i <= 3; i++ {
		if cr := e.reconcile(t); cr.Status.ConsecutiveFailures != i {
			t.Fatalf("after %d failures the status says %d", i, cr.Status.ConsecutiveFailures)
		}
	}
	e.hub.status.Store(0)
	if cr := e.reconcile(t); cr.Status.ConsecutiveFailures != 0 {
		t.Fatalf("not reset after success: %d", cr.Status.ConsecutiveFailures)
	}
}
