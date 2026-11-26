package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

// writableHub is a hub that keeps one environment and accepts saves, like the real one.
type writableHub struct {
	mu        sync.Mutex
	srv       *httptest.Server
	v         vectors
	tok       *vault.Token
	dek       []byte
	payload   vault.SealedBox
	version   int
	level     string
	rotating  bool
	saves     int
	getEnvs   int
	lastNote  string
	failSaves string // when set, saveEnv answers this error code
	raceOnce  bool   // the next saveEnv loses a race: someone else saved first
	links     []vault.AgentLink
	reports   []vault.AgentReport
	down      bool // answers 503 to everything
}

func newWritableHub(t *testing.T, v vectors) *writableHub {
	tok, err := vault.DecodeToken(v.ServiceToken)
	if err != nil {
		t.Fatal(err)
	}
	dek, err := vault.UnwrapDEK(v.Environment.WrappedEnvDek, tok.K)
	if err != nil {
		t.Fatal(err)
	}
	h := &writableHub{v: v, tok: tok, dek: dek, payload: v.Environment.Payload, version: 1, level: "write"}
	e := v.Environment
	h.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		var in struct {
			JSON struct {
				Project       string          `json:"project"`
				Payload       vault.SealedBox `json:"payload"`
				BaseUpdatedAt string          `json:"baseUpdatedAt"`
				Note          string          `json:"note"`
			} `json:"json"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &in)
		at := "2026-01-01T00:00:" + pad(h.version) + "Z"
		if h.down {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		switch r.URL.Path {
		case "/rpc/me":
			_ = json.NewEncoder(w).Encode(map[string]any{"json": map[string]any{"username": "svc-k8s-main", "kind": "service", "expiresAt": "2030-01-01T00:00:00.000Z"}})
		case "/rpc/k8s/agent/sync":
			_ = json.NewEncoder(w).Encode(map[string]any{"json": h.links})
		case "/rpc/k8s/agent/report":
			var rep struct {
				JSON struct {
					Reports []vault.AgentReport `json:"reports"`
				} `json:"json"`
			}
			_ = json.NewDecoder(bytes.NewReader(body)).Decode(&rep)
			h.reports = append(h.reports, rep.JSON.Reports...)
			_ = json.NewEncoder(w).Encode(map[string]any{"json": map[string]any{"ok": true}})
		case "/rpc/environments/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"json": []vault.EnvRow{{
				Name: e.Name, UpdatedAt: at, Level: h.level, WrappedEnvDek: e.WrappedEnvDek, KeyVersion: 1, RotatePending: h.rotating,
			}}})
		case "/rpc/environments/getEnv":
			h.getEnvs++
			_ = json.NewEncoder(w).Encode(map[string]any{"json": vault.EnvPayload{
				TenantID: e.TenantID, ProjectName: e.Project, Name: e.Name, UpdatedAt: at, Payload: h.payload,
			}})
		case "/rpc/environments/saveEnv":
			if h.raceOnce {
				h.raceOnce = false
				h.version++ // somebody else saved in between
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"json":{"code":"CONFLICT","status":409,"message":"changed"}}`))
				return
			}
			if h.failSaves != "" {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"json":{"code":"` + h.failSaves + `","status":409,"message":"changed"}}`))
				return
			}
			if in.JSON.BaseUpdatedAt != at {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"json":{"code":"CONFLICT","status":409,"message":"changed"}}`))
				return
			}
			h.payload, h.lastNote = in.JSON.Payload, in.JSON.Note
			h.version++
			h.saves++
			_ = json.NewEncoder(w).Encode(map[string]any{"json": map[string]string{"name": e.Name, "updatedAt": "2026-01-01T00:00:" + pad(h.version) + "Z"}})
		}
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func pad(n int) string { return strings.Repeat("0", 2-len(strconv.Itoa(n))) + strconv.Itoa(n) }

// stored decrypts what the hub holds, the way a client would: with the real key and location.
func (h *writableHub) stored(t *testing.T) map[string]string {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.v.Environment
	out, err := vault.OpenEnv(h.payload, h.dek, vault.EnvAAD(e.TenantID, e.Project, e.Name))
	if err != nil {
		t.Fatalf("the hub now holds something that cannot be opened: %v", err)
	}
	return out
}

func setupPush(t *testing.T, source map[string][]byte) (*PushReconciler, *writableHub, func(*testing.T) *v1.EnvVaultPush, func(map[string][]byte)) {
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
	cr := &v1.EnvVaultPush{
		ObjectMeta: metav1.ObjectMeta{Name: "push", Namespace: "prod", UID: "uid-p", Generation: 1},
		Spec: v1.EnvVaultPushSpec{
			TokenSecretRef:   v1.SecretKeyRef{Name: "envvault-token"},
			Project:          v.Environment.Project,
			Environment:      v.Environment.Name,
			SourceSecretName: "app-config",
			Hub:              v1.HubSpec{URL: h.srv.URL, InsecureSkipVerify: true},
		},
	}
	tokenSecret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "envvault-token", Namespace: "prod"}, Data: map[string][]byte{"token": []byte(v.ServiceToken)}}
	objs := []runtime.Object{cr, tokenSecret}
	if source != nil {
		objs = append(objs, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "app-config", Namespace: "prod"}, Data: source})
	}
	c := fake.NewClientBuilder().WithScheme(sch).WithRuntimeObjects(objs...).WithStatusSubresource(&v1.EnvVaultPush{}).Build()
	p := &PushReconciler{R: &Reconciler{Client: c, APIReader: c, Scheme: sch}}
	key := types.NamespacedName{Namespace: "prod", Name: "push"}
	run := func(t *testing.T) *v1.EnvVaultPush {
		t.Helper()
		if _, err := p.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err != nil {
			t.Fatal(err)
		}
		var got v1.EnvVaultPush
		if err := c.Get(context.Background(), key, &got); err != nil {
			t.Fatal(err)
		}
		return &got
	}
	setSource := func(data map[string][]byte) {
		var s corev1.Secret
		_ = c.Get(context.Background(), types.NamespacedName{Namespace: "prod", Name: "app-config"}, &s)
		s.Data = data
		if err := c.Update(context.Background(), &s); err != nil {
			t.Fatal(err)
		}
	}
	return p, h, run, setSource
}

func reasonOf(cr *v1.EnvVaultPush) string {
	c := meta.FindStatusCondition(cr.Status.Conditions, condReady)
	if c == nil {
		return ""
	}
	return c.Reason
}

func TestPushMergesAndKeepsOtherKeys(t *testing.T) {
	_, h, run, _ := setupPush(t, map[string][]byte{"NEW_KEY": []byte("fresh"), "GREETING": []byte("overridden")})
	before := h.stored(t)
	cr := run(t)
	if reasonOf(cr) != reasonPushed {
		t.Fatalf("not pushed: %+v", cr.Status.Conditions)
	}
	after := h.stored(t)
	if after["NEW_KEY"] != "fresh" || after["GREETING"] != "overridden" {
		t.Errorf("pushed values missing: %v", after)
	}
	for k, v := range before {
		if k != "GREETING" && after[k] != v {
			t.Errorf("key %q that the Secret doesn't have was changed or lost", k)
		}
	}
	if h.saves != 1 || !strings.Contains(h.lastNote, "prod/push") || cr.Status.LastPushTime == nil {
		t.Errorf("saves=%d note=%q status=%+v", h.saves, h.lastNote, cr.Status)
	}
}

func TestPushDoesNothingWhenAlreadyEqual(t *testing.T) {
	src := map[string][]byte{}
	b, _ := os.ReadFile("../../testdata/zk-6.json")
	var v vectors
	_ = json.Unmarshal(b, &v)
	for k, val := range v.Environment.Expected {
		src[k] = []byte(val)
	}
	_, h, run, _ := setupPush(t, src)
	run(t)
	run(t)
	if h.saves != 0 {
		t.Fatalf("wrote %d times though the hub already held these values", h.saves)
	}
	if h.getEnvs != 1 {
		t.Errorf("downloaded %d times, want 1 (the second check needs only the version)", h.getEnvs)
	}
}

func TestPushOnlyWhenSourceChanges(t *testing.T) {
	_, h, run, setSource := setupPush(t, map[string][]byte{"A": []byte("1")})
	run(t)
	run(t)
	run(t)
	if h.saves != 1 || h.getEnvs != 1 {
		t.Fatalf("saves=%d getEnvs=%d, want 1 and 1", h.saves, h.getEnvs)
	}
	setSource(map[string][]byte{"A": []byte("2")})
	run(t)
	if h.saves != 2 || h.stored(t)["A"] != "2" {
		t.Fatalf("change not pushed: saves=%d", h.saves)
	}
}

func TestPushRevertsEditMadeOnTheHub(t *testing.T) {
	_, h, run, _ := setupPush(t, map[string][]byte{"A": []byte("from-cluster")})
	run(t)
	// Someone edits the hub: the version moves on.
	h.mu.Lock()
	h.version++
	h.mu.Unlock()
	h.mu.Lock()
	e := h.v.Environment
	box, _ := vault.SealEnv(map[string]string{"A": "edited-on-hub"}, h.dek, vault.EnvAAD(e.TenantID, e.Project, e.Name))
	h.payload = box
	h.mu.Unlock()
	run(t)
	if got := h.stored(t)["A"]; got != "from-cluster" {
		t.Fatalf("the Secret is the source of truth, but the hub holds %q", got)
	}
}

func TestPushRefusesReadOnlyToken(t *testing.T) {
	_, h, run, _ := setupPush(t, map[string][]byte{"A": []byte("1")})
	h.level = "read"
	cr := run(t)
	if reasonOf(cr) != reasonReadOnly || h.saves != 0 {
		t.Fatalf("reason=%s saves=%d", reasonOf(cr), h.saves)
	}
}

func TestPushWaitsForRekey(t *testing.T) {
	_, h, run, _ := setupPush(t, map[string][]byte{"A": []byte("1")})
	h.rotating = true
	if cr := run(t); reasonOf(cr) != reasonRekeying || h.saves != 0 {
		t.Fatalf("reason=%s saves=%d", reasonOf(cr), h.saves)
	}
}

func TestPushConflictIsRetriedNotForced(t *testing.T) {
	_, h, run, _ := setupPush(t, map[string][]byte{"A": []byte("1")})
	h.failSaves = "CONFLICT"
	cr := run(t)
	if reasonOf(cr) != reasonHubConflict || cr.Status.ConsecutiveFailures != 1 {
		t.Fatalf("reason=%s failures=%d", reasonOf(cr), cr.Status.ConsecutiveFailures)
	}
	h.failSaves = ""
	if cr := run(t); reasonOf(cr) != reasonPushed || h.stored(t)["A"] != "1" {
		t.Fatalf("did not recover: %s", reasonOf(cr))
	}
}

func TestPushLosingARaceRetriesAtOnce(t *testing.T) {
	_, h, run, _ := setupPush(t, map[string][]byte{"A": []byte("1")})
	h.raceOnce = true
	cr := run(t)
	if reasonOf(cr) != reasonPushed || cr.Status.ConsecutiveFailures != 0 || h.stored(t)["A"] != "1" || h.saves != 1 {
		t.Fatalf("reason=%s failures=%d saves=%d", reasonOf(cr), cr.Status.ConsecutiveFailures, h.saves)
	}
}

func TestPushRefusesBadSources(t *testing.T) {
	cases := map[string]struct {
		src    map[string][]byte
		reason string
	}{
		"missing":     {nil, reasonMisconfigured},
		"empty":       {map[string][]byte{}, reasonSourceEmpty},
		"binary data": {map[string][]byte{"KEY": {0xff, 0xfe, 0x00}}, reasonInvalidValue},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, h, run, _ := setupPush(t, tc.src)
			cr := run(t)
			if reasonOf(cr) != tc.reason || h.saves != 0 {
				t.Fatalf("reason=%s saves=%d", reasonOf(cr), h.saves)
			}
		})
	}
}

func TestPushStatusNeverHoldsValues(t *testing.T) {
	_, _, run, _ := setupPush(t, map[string][]byte{"SECRET_THING": []byte("hunter2-do-not-leak")})
	cr := run(t)
	b, _ := json.Marshal(cr.Status)
	if strings.Contains(string(b), "hunter2") {
		t.Fatalf("status leaks a value: %s", b)
	}
}

func TestPushRefusesASecretThatIsPulledFromTheHub(t *testing.T) {
	p, h, run, _ := setupPush(t, map[string][]byte{"A": []byte("1")})
	var s corev1.Secret
	if err := p.R.Get(context.Background(), types.NamespacedName{Namespace: "prod", Name: "app-config"}, &s); err != nil {
		t.Fatal(err)
	}
	s.Labels = map[string]string{ManagedByLabel: ManagedByValue}
	if err := p.R.Update(context.Background(), &s); err != nil {
		t.Fatal(err)
	}
	cr := run(t)
	if reasonOf(cr) != reasonMisconfigured || h.saves != 0 {
		t.Fatalf("reason=%s saves=%d", reasonOf(cr), h.saves)
	}
}

func TestPushLabelsItsSourceAndMapsEditsToThePush(t *testing.T) {
	p, _, run, _ := setupPush(t, map[string][]byte{"A": []byte("1")})
	run(t)
	var s corev1.Secret
	if err := p.R.Get(context.Background(), types.NamespacedName{Namespace: "prod", Name: "app-config"}, &s); err != nil {
		t.Fatal(err)
	}
	if s.Labels[ManagedByLabel] != PushSourceValue || string(s.Data["A"]) != "1" {
		t.Fatalf("source not labelled, or its data was touched: %+v", s.ObjectMeta)
	}
	if reqs := p.pushesFor(context.Background(), &s); len(reqs) != 1 || reqs[0].Name != "push" {
		t.Fatalf("an edit to the source must trigger the push: %v", reqs)
	}
	other := s.DeepCopy()
	other.Name = "unrelated"
	if reqs := p.pushesFor(context.Background(), other); len(reqs) != 0 {
		t.Fatalf("an unrelated Secret triggered a push: %v", reqs)
	}
	plain := s.DeepCopy()
	plain.Labels = nil
	if reqs := p.pushesFor(context.Background(), plain); len(reqs) != 0 {
		t.Fatalf("an unlabelled Secret must be ignored: %v", reqs)
	}
}
