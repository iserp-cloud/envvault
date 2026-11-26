package vault

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeHub serves the two read procedures from the TypeScript vectors.
func fakeHub(t *testing.T, v vectors, tok *Token) *httptest.Server {
	t.Helper()
	e := v.Environment
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer "+tok.T {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"json":{"defined":false,"code":"UNAUTHORIZED","status":401,"message":"no"}}`))
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
			_ = json.NewEncoder(w).Encode(map[string]any{"json": []EnvRow{{Name: e.Name, UpdatedAt: "2026-01-01T00:00:00Z", Level: "read", WrappedEnvDek: e.WrappedEnvDek, KeyVersion: 1}}})
		case "/rpc/environments/getEnv":
			_ = json.NewEncoder(w).Encode(map[string]any{"json": EnvPayload{TenantID: e.TenantID, ProjectName: e.Project, Name: e.Name, Payload: e.Payload}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func setup(t *testing.T) (vectors, *Token, *httptest.Server) {
	v := load(t)
	tok, err := DecodeToken(v.ServiceToken)
	if err != nil {
		t.Fatal(err)
	}
	return v, tok, fakeHub(t, v, tok)
}

func leafFingerprint(srv *httptest.Server) string {
	sum := sha256.Sum256(srv.Certificate().Raw)
	return hex.EncodeToString(sum[:])
}

func TestReadWithPin(t *testing.T) {
	v, tok, srv := setup(t)
	c, err := NewClient(srv.URL, tok.T, TLSOptions{Fingerprint: strings.ToUpper(leafFingerprint(srv))})
	if err != nil {
		t.Fatal(err)
	}
	got, row, err := c.Read(context.Background(), tok, v.Environment.Project, "Production")
	if err != nil {
		t.Fatal(err)
	}
	if got["API_KEY"] != v.Environment.Expected["API_KEY"] || row.KeyVersion != 1 {
		t.Fatalf("unexpected result: %v %v", got, row)
	}
}

func TestReadWithCA(t *testing.T) {
	v, tok, srv := setup(t)
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	c, err := NewClient(srv.URL, tok.T, TLSOptions{CAPEM: ca})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Read(context.Background(), tok, v.Environment.Project, v.Environment.Name); err != nil {
		t.Fatal(err)
	}
}

func TestUntrustedCertificateRefused(t *testing.T) {
	v, tok, srv := setup(t)
	c, _ := NewClient(srv.URL, tok.T, TLSOptions{})
	if _, _, err := c.Read(context.Background(), tok, v.Environment.Project, v.Environment.Name); err == nil {
		t.Fatal("trusted an unknown certificate")
	}
}

func TestWrongPinRefused(t *testing.T) {
	v, tok, srv := setup(t)
	c, _ := NewClient(srv.URL, tok.T, TLSOptions{Fingerprint: strings.Repeat("ab", 32)})
	if _, _, err := c.Read(context.Background(), tok, v.Environment.Project, v.Environment.Name); err == nil {
		t.Fatal("accepted a certificate that does not match the pin")
	}
}

func TestMissingEnvironmentIsNoAccess(t *testing.T) {
	v, tok, srv := setup(t)
	c, _ := NewClient(srv.URL, tok.T, TLSOptions{Insecure: true})
	_, _, err := c.Read(context.Background(), tok, "other-project", v.Environment.Name)
	if !NoAccess(err) {
		t.Fatalf("want no-access, got %v", err)
	}
}

func TestBadBearerIsUnauthorized(t *testing.T) {
	v, tok, srv := setup(t)
	c, _ := NewClient(srv.URL, "wrong", TLSOptions{Insecure: true})
	_, _, err := c.Read(context.Background(), tok, v.Environment.Project, v.Environment.Name)
	if !Unauthorized(err) {
		t.Fatalf("want unauthorized, got %v", err)
	}
}

func TestRedirectIsNotFollowed(t *testing.T) {
	hits := 0
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	defer other.Close()
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusPermanentRedirect)
	}))
	defer hub.Close()
	c, _ := NewClient(hub.URL, "secret", TLSOptions{})
	if _, err := c.ListEnvironments(context.Background(), "t", "p"); err == nil || hits != 0 {
		t.Fatalf("followed a redirect (hits=%d, err=%v)", hits, err)
	}
}

func TestParseHubURL(t *testing.T) {
	if got, err := ParseHubURL("https://hub:30847/", false); err != nil || got != "https://hub:30847" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := ParseHubURL("http://hub:3847", false); err == nil {
		t.Error("accepted plain http")
	}
	if _, err := ParseHubURL("http://hub:3847", true); err != nil {
		t.Error("refused plain http that was allowed")
	}
	if _, err := ParseHubURL("hub", false); err == nil {
		t.Error("accepted a bare host")
	}
}

func TestNormalizeFingerprint(t *testing.T) {
	hex64 := strings.Repeat("ab", 32)
	for _, in := range []string{hex64, "sha256:" + hex64, strings.ToUpper(hex64)} {
		if got, err := NormalizeFingerprint(in); err != nil || got != hex64 {
			t.Errorf("%q -> %q %v", in, got, err)
		}
	}
	if _, err := NormalizeFingerprint("abcd"); err == nil {
		t.Error("accepted a short fingerprint")
	}
}

func TestExpiryIsAskedOnceAndToleratesOlderHubs(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"json":{"username":"svc-x","kind":"service","expiresAt":"2030-05-01T00:00:00.000Z"}}`))
	}))
	defer srv.Close()
	c, err := NewClient(srv.URL, "tok", TLSOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if at, ok := c.Expiry(context.Background()); !ok || at.Year() != 2030 {
			t.Fatalf("expiry = %v %v", at, ok)
		}
	}
	if calls != 1 {
		t.Fatalf("asked the hub %d times", calls)
	}
	// An extension made on the hub must show up: the answer is not kept for ever.
	c.checked = time.Now().Add(-2 * expiryTTL)
	c.Expiry(context.Background())
	if calls != 2 {
		t.Fatalf("a stale answer was not asked again (%d calls)", calls)
	}

	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"json":{"username":"svc-x","kind":"service"}}`))
	}))
	defer old.Close()
	c, _ = NewClient(old.URL, "tok", TLSOptions{})
	if _, ok := c.Expiry(context.Background()); ok {
		t.Fatal("a hub that does not report expiry must give ok=false")
	}
}

func TestAgentReportSplitsBigBatchesUnderTheHubLimit(t *testing.T) {
	var sizes []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			JSON struct {
				Reports []AgentReport `json:"reports"`
			} `json:"json"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		sizes = append(sizes, len(in.JSON.Reports))
		if len(in.JSON.Reports) > 500 { // the hub's own limit
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"json":{"defined":false,"code":"BAD_REQUEST","status":400,"message":"too many"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"json":{"ok":true}}`))
	}))
	defer srv.Close()
	c, err := NewClient(srv.URL, "tok", TLSOptions{})
	if err != nil {
		t.Fatal(err)
	}
	reports := make([]AgentReport, 1250)
	for i := range reports {
		reports[i] = AgentReport{ID: "l", Status: "Synced"}
	}
	if err := c.AgentReport(context.Background(), reports); err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, n := range sizes {
		total += n
	}
	if total != 1250 || len(sizes) != 4 {
		t.Fatalf("batches = %v", sizes)
	}
}
