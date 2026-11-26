package controller

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
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

type linkEnv struct {
	l *LinkReconciler
	h *writableHub
	c client.Client
	v vectors
}

func setupLinks(t *testing.T, allowed ...string) *linkEnv {
	t.Helper()
	b, err := os.ReadFile("../../testdata/zk-6.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	h := newWritableHub(t, v)
	sch := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(sch)
	_ = v1.AddToScheme(sch)
	tokenSecret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "cluster-token", Namespace: "envvault-system"}, Data: map[string][]byte{"token": []byte(v.ServiceToken)}}
	c := fake.NewClientBuilder().WithScheme(sch).WithObjects(tokenSecret).Build()
	rec := &Reconciler{Client: c, APIReader: c, Scheme: sch}
	l := &LinkReconciler{
		R: rec, P: &PushReconciler{R: rec},
		TokenSecret: types.NamespacedName{Namespace: "envvault-system", Name: "cluster-token"},
		HubURL:      h.srv.URL, TLS: vault.TLSOptions{Insecure: true},
		Version: "test",
	}
	l.init()
	l.setNamespaces(allowed)
	return &linkEnv{l: l, h: h, c: c, v: v}
}

func (e *linkEnv) link(id, ns, name, dir string) vault.AgentLink {
	return vault.AgentLink{ID: id, Project: e.v.Environment.Project, Environment: e.v.Environment.Name, Namespace: ns, SecretName: name, Direction: dir}
}

func (e *linkEnv) poll(t *testing.T) {
	t.Helper()
	if err := e.l.poll(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func (e *linkEnv) reconcile(t *testing.T, id string) {
	t.Helper()
	if _, err := e.l.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: id}}); err != nil {
		t.Fatal(err)
	}
}

// lastReport is what the hub was last told about a link.
func (e *linkEnv) lastReport(id string) (vault.AgentReport, bool) {
	e.h.mu.Lock()
	defer e.h.mu.Unlock()
	for i := len(e.h.reports) - 1; i >= 0; i-- {
		if e.h.reports[i].ID == id {
			return e.h.reports[i], true
		}
	}
	return vault.AgentReport{}, false
}

func (e *linkEnv) secret(ns, name string) (*corev1.Secret, bool) {
	var s corev1.Secret
	if err := e.c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: name}, &s); err != nil {
		return nil, false
	}
	return &s, true
}

func TestLinkPullWritesTheSecretAndReportsBack(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.links = []vault.AgentLink{e.link("l1", "prod", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	s, ok := e.secret("prod", "app-env")
	if !ok || len(s.Data) == 0 {
		t.Fatal("the linked Secret was not created")
	}
	if s.Labels[LinkLabel] != "l1" || s.Labels[ManagedByLabel] != ManagedByValue || len(s.OwnerReferences) != 0 {
		t.Fatalf("labels=%v owners=%v", s.Labels, s.OwnerReferences)
	}
	e.poll(t) // flushes the report
	r, ok := e.lastReport("l1")
	if !ok || r.Status != reasonSynced || r.KeyCount != len(s.Data) {
		t.Fatalf("report = %+v ok=%v", r, ok)
	}
}

func TestLinkRefusesANamespaceItMayNotUse(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.links = []vault.AgentLink{e.link("l1", "kube-system", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	if _, ok := e.secret("kube-system", "app-env"); ok {
		t.Fatal("wrote into a namespace that is not allowed")
	}
	e.poll(t)
	if r, _ := e.lastReport("l1"); r.Status != reasonNamespace {
		t.Fatalf("report = %+v", r)
	}
}

func TestLinkNeverOverwritesASecretItDidNotWrite(t *testing.T) {
	e := setupLinks(t, "prod")
	mine := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "app-env", Namespace: "prod"}, Data: map[string][]byte{"KEEP": []byte("me")}}
	if err := e.c.Create(context.Background(), mine); err != nil {
		t.Fatal(err)
	}
	e.h.links = []vault.AgentLink{e.link("l1", "prod", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	s, _ := e.secret("prod", "app-env")
	if string(s.Data["KEEP"]) != "me" || len(s.Data) != 1 {
		t.Fatalf("an existing Secret was overwritten: %v", s.Data)
	}
	e.poll(t)
	if r, _ := e.lastReport("l1"); r.Status != reasonConflict {
		t.Fatalf("report = %+v", r)
	}
}

func TestRemovedLinkLeavesTheSecretInPlaceButLetsGo(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.links = []vault.AgentLink{e.link("l1", "prod", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	before, _ := e.secret("prod", "app-env")

	e.h.links = nil // unlinked in the dashboard
	e.poll(t)
	s, ok := e.secret("prod", "app-env")
	if !ok || len(s.Data) != len(before.Data) {
		t.Fatal("unlinking must not delete the Secret or its values")
	}
	if _, linked := s.Labels[LinkLabel]; linked || s.Labels[ManagedByLabel] != "" {
		t.Fatalf("the Secret is still claimed: %v", s.Labels)
	}
	e.reconcile(t, "l1") // a late reconcile of a removed link does nothing
}

func TestLinkSurvivesAHubOutage(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.links = []vault.AgentLink{e.link("l1", "prod", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	e.h.mu.Lock()
	e.h.down = true
	e.h.mu.Unlock()
	if err := e.l.poll(context.Background()); err == nil {
		t.Fatal("a failed poll must say so")
	}
	// An unreachable hub is not "no links": nothing is released.
	if s, ok := e.secret("prod", "app-env"); !ok || s.Labels[LinkLabel] != "l1" {
		t.Fatal("the Secret was released during an outage")
	}
	e.h.mu.Lock()
	e.h.down = false
	e.h.mu.Unlock()
	e.poll(t)
	e.reconcile(t, "l1")
}

func TestLinkPushWritesTheEnvironmentFromTheSecret(t *testing.T) {
	e := setupLinks(t, "prod")
	src := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "app-config", Namespace: "prod"}, Data: map[string][]byte{"FROM_CLUSTER": []byte("yes")}}
	if err := e.c.Create(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	e.h.links = []vault.AgentLink{e.link("l2", "prod", "app-config", "push")}
	e.poll(t)
	e.reconcile(t, "l2")
	if got := e.h.stored(t)["FROM_CLUSTER"]; got != "yes" {
		t.Fatalf("hub holds %q", got)
	}
	if e.h.saves != 1 || e.h.lastNote == "" {
		t.Fatalf("saves=%d note=%q", e.h.saves, e.h.lastNote)
	}
	e.reconcile(t, "l2") // unchanged: no second save
	if e.h.saves != 1 {
		t.Fatalf("saves=%d after an unchanged check", e.h.saves)
	}
	e.poll(t)
	if r, _ := e.lastReport("l2"); r.Status != reasonPushed {
		t.Fatalf("report = %+v", r)
	}
	// An edit of the source Secret finds its link at once.
	var s corev1.Secret
	_ = e.c.Get(context.Background(), types.NamespacedName{Namespace: "prod", Name: "app-config"}, &s)
	if reqs := e.l.linksFor(context.Background(), &s); len(reqs) != 1 || reqs[0].Name != "l2" {
		t.Fatalf("an edited push source maps to %v", reqs)
	}
}

// A status the hub holds can be out of step with what was last accepted (a replaced token took
// the links over). An unchanged status must not stay unsent for ever.
func TestLinkResendsStatusAfterATokenSwapAndPeriodically(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.links = []vault.AgentLink{e.link("l1", "prod", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	e.poll(t)
	if _, ok := e.lastReport("l1"); !ok {
		t.Fatal("first report missing")
	}
	forget := func() {
		e.h.mu.Lock()
		e.h.reports = nil
		e.h.mu.Unlock()
	}

	forget()
	e.poll(t)
	if _, ok := e.lastReport("l1"); ok {
		t.Fatal("an unchanged status was sent again straight away")
	}

	forget()
	e.l.tok.U = "svc-k8s-before-the-swap" // the token Secret now names another account
	e.poll(t)
	if r, ok := e.lastReport("l1"); !ok || r.Status != reasonSynced {
		t.Fatalf("a new identity must send every status again, got %+v ok=%v", r, ok)
	}

	forget()
	e.l.resent = e.l.resent.Add(-2 * resendEvery)
	e.poll(t)
	if _, ok := e.lastReport("l1"); !ok {
		t.Fatal("statuses must be sent again every few minutes")
	}
}

// A Secret the cluster will not take (too big, or no such namespace) is not a name clash.
func TestWriteFailureNamesTheRealCause(t *testing.T) {
	gr := schema.GroupResource{Resource: "secrets"}
	for _, tc := range []struct {
		err  error
		want string
	}{
		{apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, "x"), reasonMisconfigured},
		{apierrors.NewInvalid(schema.GroupKind{Kind: "Secret"}, "s", nil), reasonRejected},
		{apierrors.NewForbidden(gr, "s", errors.New("no")), reasonRejected},
		{errors.New("boom"), reasonRejected},
	} {
		if got := writeFailure("Secret", "ns", "s", tc.err).reason; got != tc.want {
			t.Errorf("%v -> %s, want %s", tc.err, got, tc.want)
		}
	}
}

// Hundreds of links arriving in one poll (an operator restart, a bulk link) used to overflow the event
// channel; the dropped ones were never started because they were no longer "new" on the next poll.
func TestPollStartsEveryLinkEvenWhenTheyOutnumberTheQueue(t *testing.T) {
	e := setupLinks(t, "prod")
	const n = 600
	for i := 0; i < n; i++ {
		e.h.links = append(e.h.links, e.link(fmt.Sprintf("l%d", i), "prod", fmt.Sprintf("s%d", i), "pull"))
	}
	got := map[string]bool{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for len(got) < n {
			select {
			case ev := <-e.l.events:
				got[ev.Object.GetName()] = true
				time.Sleep(200 * time.Microsecond) // a consumer slower than the poll
			case <-time.After(5 * time.Second):
				return
			}
		}
	}()
	e.poll(t)
	<-done
	if len(got) != n {
		t.Fatalf("%d of %d links were started", len(got), n)
	}
}

// existing creates a Secret that is already in the cluster before any link touches it.
func (e *linkEnv) existing(t *testing.T, name string, labels, annotations map[string]string) {
	t.Helper()
	s := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "prod", Labels: labels, Annotations: annotations},
		Type:       corev1.SecretTypeOpaque, // what the API server gives a Secret made without one
		Data:       map[string][]byte{"OLD": []byte("value")},
	}
	if err := e.c.Create(context.Background(), s); err != nil {
		t.Fatal(err)
	}
}

func (e *linkEnv) pull(t *testing.T, l vault.AgentLink) (vault.AgentReport, *corev1.Secret) {
	t.Helper()
	e.h.links = []vault.AgentLink{l}
	e.poll(t)
	e.reconcile(t, l.ID)
	e.poll(t)
	r, _ := e.lastReport(l.ID)
	s, _ := e.secret("prod", l.SecretName)
	return r, s
}

func TestAnExistingSecretIsRefusedWithTheFixInTheMessage(t *testing.T) {
	e := setupLinks(t, "prod")
	e.existing(t, "app-env", nil, nil)
	r, s := e.pull(t, e.link("l1", "prod", "app-env", "pull"))
	if r.Status != reasonConflict || !strings.Contains(r.Message, "kubectl -n prod annotate secret app-env "+AdoptAnnotation+"=true") {
		t.Fatalf("report = %+v", r)
	}
	if string(s.Data["OLD"]) != "value" {
		t.Fatalf("the Secret was touched: %v", s.Data)
	}
}

func TestTheSecretsOwnerCanInviteATakeOver(t *testing.T) {
	e := setupLinks(t, "prod")
	e.existing(t, "app-env", nil, map[string]string{AdoptAnnotation: "true"})
	r, s := e.pull(t, e.link("l1", "prod", "app-env", "pull"))
	if r.Status != reasonSynced {
		t.Fatalf("report = %+v", r)
	}
	if s.Labels[LinkLabel] != "l1" || s.Labels[ManagedByLabel] != ManagedByValue {
		t.Fatalf("not claimed: %v", s.Labels)
	}
	if _, kept := s.Data["OLD"]; kept || len(s.Data) == 0 {
		t.Fatalf("the Secret was not replaced by the environment: %v", s.Data)
	}
	if _, left := s.Annotations[AdoptAnnotation]; left {
		t.Fatal("the invitation should be used up")
	}
}

func TestTheHubLinkCanAskForATakeOver(t *testing.T) {
	e := setupLinks(t, "prod")
	e.existing(t, "app-env", nil, nil)
	l := e.link("l1", "prod", "app-env", "pull")
	l.Adopt = true
	r, s := e.pull(t, l)
	if r.Status != reasonSynced || s.Labels[LinkLabel] != "l1" {
		t.Fatalf("report = %+v labels = %v", r, s.Labels)
	}
}

func TestALinkRelinkedToAReleasedSecretNeedsTheTakeOver(t *testing.T) {
	e := setupLinks(t, "prod")
	r, _ := e.pull(t, e.link("l1", "prod", "app-env", "pull"))
	if r.Status != reasonSynced {
		t.Fatalf("first link = %+v", r)
	}
	e.h.links = nil
	e.poll(t) // the link is removed: the Secret is released
	if s, _ := e.secret("prod", "app-env"); s.Labels[LinkLabel] != "" {
		t.Fatalf("not released: %v", s.Labels)
	}
	if r, _ := e.pull(t, e.link("l2", "prod", "app-env", "pull")); r.Status != reasonConflict {
		t.Fatalf("a new link took a Secret it was not invited to: %+v", r)
	}
	l := e.link("l2", "prod", "app-env", "pull")
	l.Adopt = true
	if r, _ := e.pull(t, l); r.Status != reasonSynced {
		t.Fatalf("with the take-over: %+v", r)
	}
}

func TestATakeOverNeverReachesASecretSomethingElseOwns(t *testing.T) {
	cases := map[string]struct {
		labels map[string]string
		owner  bool
	}{
		"another link":      {labels: map[string]string{LinkLabel: "other"}},
		"a push source":     {labels: map[string]string{ManagedByLabel: PushSourceValue}},
		"a custom resource": {owner: true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e := setupLinks(t, "prod")
			e.existing(t, "app-env", c.labels, map[string]string{AdoptAnnotation: "true"})
			if c.owner {
				s, _ := e.secret("prod", "app-env")
				yes := true
				s.OwnerReferences = []metav1.OwnerReference{{APIVersion: "v1", Kind: "ConfigMap", Name: "x", UID: "u", Controller: &yes}}
				if err := e.c.Update(context.Background(), s); err != nil {
					t.Fatal(err)
				}
			}
			l := e.link("l1", "prod", "app-env", "pull")
			l.Adopt = true
			e.h.links = []vault.AgentLink{l}
			if other := c.labels[LinkLabel]; other != "" {
				// The owner is a link that exists; a label for one that doesn't is just a leftover.
				e.h.links = append(e.h.links, e.link(other, "prod", "elsewhere", "pull"))
			}
			e.poll(t)
			e.reconcile(t, l.ID)
			e.poll(t)
			r, _ := e.lastReport(l.ID)
			s, _ := e.secret("prod", "app-env")
			if r.Status != reasonConflict || string(s.Data["OLD"]) != "value" {
				t.Fatalf("report = %+v data = %v", r, s.Data)
			}
		})
	}
}

func TestTokenMissingIsTrueOnlyWhenTheSecretIsAbsent(t *testing.T) {
	ctx := context.Background()
	e := setupLinks(t, "*")
	if e.l.tokenMissing(ctx) {
		t.Fatal("tokenMissing = true although the token Secret exists")
	}
	if err := e.c.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: e.l.TokenSecret.Namespace, Name: e.l.TokenSecret.Name}}); err != nil {
		t.Fatal(err)
	}
	if !e.l.tokenMissing(ctx) {
		t.Fatal("tokenMissing = false with no token Secret")
	}
}

// A ConfigMap, not a flag, says where links may write, so it can change without reinstalling the operator.
func TestTheNamespaceRestrictionComesFromAConfigMapAndChangesLive(t *testing.T) {
	ctx := context.Background()
	e := setupLinks(t) // nothing known yet
	e.l.Config = types.NamespacedName{Namespace: "envvault-system", Name: "envvault-config"}
	if e.l.allowed("prod") {
		t.Fatal("allowed before the restriction was ever read")
	}
	put := func(data map[string]string) {
		t.Helper()
		cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "envvault-system", Name: "envvault-config"}, Data: data}
		if err := e.c.Create(ctx, cm); err != nil {
			t.Fatal(err)
		}
	}

	// No ConfigMap: every namespace.
	e.h.links = []vault.AgentLink{e.link("l1", "prod", "app-env", "pull"), e.link("l2", "staging", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	e.reconcile(t, "l2")
	if _, ok := e.secret("staging", "app-env"); !ok {
		t.Fatal("no ConfigMap should allow every namespace")
	}

	// Limit it to prod while the operator keeps running: staging is now refused, prod is not.
	put(map[string]string{NamespacesKey: "prod, app-a\napp-b"})
	e.poll(t)
	for _, ns := range []string{"prod", "app-a", "app-b"} {
		if !e.l.allowed(ns) {
			t.Fatalf("%s should be allowed", ns)
		}
	}
	if e.l.allowed("staging") {
		t.Fatal("staging should be refused after the ConfigMap limits links to prod")
	}
	e.reconcile(t, "l2")
	e.poll(t) // flushes the report
	if r, _ := e.lastReport("l2"); r.Status != reasonNamespace {
		t.Fatalf("l2 report after the restriction = %+v", r)
	}
	// What the hub is told it may offer follows the list too.
	if got := e.l.visibleNamespaces(ctx); len(got) != 3 || got[0] != "app-a" {
		t.Fatalf("visible namespaces = %v", got)
	}

	// A key that is there but empty allows nothing; removing the key allows everything again.
	var cm corev1.ConfigMap
	if err := e.c.Get(ctx, e.l.Config, &cm); err != nil {
		t.Fatal(err)
	}
	cm.Data[NamespacesKey] = ""
	if err := e.c.Update(ctx, &cm); err != nil {
		t.Fatal(err)
	}
	e.poll(t)
	if e.l.allowed("prod") {
		t.Fatal("an empty list should allow nothing")
	}
	delete(cm.Data, NamespacesKey)
	if err := e.c.Update(ctx, &cm); err != nil {
		t.Fatal(err)
	}
	e.poll(t)
	if !e.l.allowed("staging") {
		t.Fatal("a ConfigMap without the key should allow every namespace")
	}
}

// The hub address and pin live in the ConfigMap too, so changing them needs no reinstall.
func TestTheHubAddressAndPinComeFromTheConfigMapAndChangeLive(t *testing.T) {
	ctx := context.Background()
	e := setupLinks(t, "prod")
	e.l.Config = types.NamespacedName{Namespace: "envvault-system", Name: "envvault-config"}
	goodURL := e.l.HubURL // what the flags say
	set := func(data map[string]string) {
		t.Helper()
		cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "envvault-system", Name: "envvault-config"}, Data: data}
		var old corev1.ConfigMap
		if err := e.c.Get(ctx, e.l.Config, &old); err == nil {
			cm.ResourceVersion = old.ResourceVersion
			if err := e.c.Update(ctx, cm); err != nil {
				t.Fatal(err)
			}
			return
		}
		if err := e.c.Create(ctx, cm); err != nil {
			t.Fatal(err)
		}
	}

	// No ConfigMap: the flags' address is used and the poll works.
	if err := e.l.poll(ctx); err != nil {
		t.Fatalf("poll with the flags' address: %v", err)
	}
	if addr, _ := e.l.hubSettings(); addr != goodURL {
		t.Fatalf("address = %q, want the flags' %q", addr, goodURL)
	}

	// A wrong address in the ConfigMap wins over the flags, so the poll now fails ...
	set(map[string]string{HubURLKey: "https://127.0.0.1:1"})
	if err := e.l.poll(ctx); err == nil {
		t.Fatal("poll succeeded although the ConfigMap points at a dead address")
	}
	if addr, _ := e.l.hubSettings(); addr != "https://127.0.0.1:1" {
		t.Fatalf("address = %q", addr)
	}

	// ... and putting the right one there fixes it on the next poll, with nothing restarted.
	set(map[string]string{HubURLKey: " " + goodURL + " ", HubFingerprintKey: "AB:CD"})
	if _, tlsOpts := e.l.hubSettings(); tlsOpts.Fingerprint != "" {
		t.Fatal("the pin was applied before the ConfigMap was read")
	}
	e.l.refreshConfig(ctx)
	if addr, tlsOpts := e.l.hubSettings(); addr != goodURL || tlsOpts.Fingerprint != "AB:CD" || !tlsOpts.Insecure {
		t.Fatalf("settings = %q %+v (want the ConfigMap's address and pin, the flags' other TLS options)", addr, tlsOpts)
	}
	set(map[string]string{HubURLKey: goodURL}) // no pin: the test hub has none to match
	if err := e.l.poll(ctx); err != nil {
		t.Fatalf("poll after the ConfigMap was corrected: %v", err)
	}

	// Deleting the ConfigMap goes back to the flags.
	if err := e.c.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "envvault-system", Name: "envvault-config"}}); err != nil {
		t.Fatal(err)
	}
	e.l.refreshConfig(ctx)
	if addr, tlsOpts := e.l.hubSettings(); addr != goodURL || tlsOpts.Fingerprint != "" {
		t.Fatalf("after deleting the ConfigMap: %q %+v", addr, tlsOpts)
	}
}

// Unlinking a push link must give the Secret back: its push-source label would otherwise make every
// later link to that Secret fail with "belongs to something else", with no take-over possible.
func TestUnlinkingAPushLinkReleasesItsSourceSecret(t *testing.T) {
	ctx := context.Background()
	e := setupLinks(t, "prod")
	src := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "app-config", Namespace: "prod"}, Type: corev1.SecretTypeOpaque, Data: map[string][]byte{"FROM_CLUSTER": []byte("yes")}}
	if err := e.c.Create(ctx, src); err != nil {
		t.Fatal(err)
	}
	e.h.links = []vault.AgentLink{e.link("l2", "prod", "app-config", "push")}
	e.poll(t)
	e.reconcile(t, "l2")
	s, _ := e.secret("prod", "app-config")
	if s.Labels[ManagedByLabel] != PushSourceValue {
		t.Fatalf("the push source was not marked: %v", s.Labels)
	}

	e.h.links = nil // removed in the dashboard
	e.poll(t)
	s, _ = e.secret("prod", "app-config")
	if _, marked := s.Labels[ManagedByLabel]; marked {
		t.Fatalf("the push-source label survived the unlink: %v", s.Labels)
	}
	if string(s.Data["FROM_CLUSTER"]) != "yes" {
		t.Fatal("the Secret's data was touched")
	}

	// So a pull link can now be made on it, with the usual take-over.
	l := e.link("l3", "prod", "app-config", "pull")
	l.Adopt = true
	e.h.links = []vault.AgentLink{l}
	e.poll(t)
	e.reconcile(t, "l3")
	e.poll(t)
	if r, _ := e.lastReport("l3"); r.Status != reasonSynced {
		t.Fatalf("a pull link on the released Secret: %+v", r)
	}
}

// A link removed while the operator was not running its link controller (an older image, a restart)
// is never released, so its label stays on the Secret. A label for a link that no longer exists is
// not an owner: the Secret counts as released, and the usual take-over rule applies.
func TestASecretLabelledForALinkThatNoLongerExistsCountsAsReleased(t *testing.T) {
	stale := map[string]string{LinkLabel: "gone-link", ManagedByLabel: ManagedByValue}

	// Without the take-over it is refused, but as an ordinary existing Secret, with the fix in the message.
	e := setupLinks(t, "prod")
	e.existing(t, "app-env", stale, nil)
	r, s := e.pull(t, e.link("l1", "prod", "app-env", "pull"))
	if r.Status != reasonConflict || !strings.Contains(r.Message, "annotate") || strings.Contains(r.Message, "belongs to something else") {
		t.Fatalf("report = %+v", r)
	}
	if s.Labels[LinkLabel] != "" || string(s.Data["OLD"]) != "value" {
		t.Fatalf("labels = %v data = %v (the stale label should be gone and the data untouched)", s.Labels, s.Data)
	}

	// With the take-over it is taken.
	e = setupLinks(t, "prod")
	e.existing(t, "app-env", stale, nil)
	l := e.link("l1", "prod", "app-env", "pull")
	l.Adopt = true
	if r, s := e.pull(t, l); r.Status != reasonSynced || s.Labels[LinkLabel] != "l1" {
		t.Fatalf("report = %+v labels = %v", r, s.Labels)
	}

	// A label for a link that does exist is still respected.
	e = setupLinks(t, "prod")
	e.existing(t, "app-env", map[string]string{LinkLabel: "l9", ManagedByLabel: ManagedByValue}, nil)
	e.h.links = []vault.AgentLink{e.link("l9", "prod", "other", "pull"), e.link("l1", "prod", "app-env", "pull")}
	e.poll(t)
	e.reconcile(t, "l1")
	e.poll(t)
	if r, _ := e.lastReport("l1"); r.Status != reasonConflict || !strings.Contains(r.Message, "belongs to something else") {
		t.Fatalf("a live link's Secret was not respected: %+v", r)
	}
}
