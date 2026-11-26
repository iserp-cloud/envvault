package vault

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const maxResponse = 16 << 20

// TLSOptions says how to trust the hub. With none set the system roots are used.
type TLSOptions struct {
	CAPEM       []byte // extra root(s) to trust, PEM
	Fingerprint string // pin the hub's certificate: SHA-256 hex, with or without colons or a `sha256:` prefix
	Insecure    bool   // skip verification entirely (testing only)
}

// APIError is a non-2xx answer from the hub.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("hub answered %d %s: %s", e.Status, e.Code, e.Message)
}

// NoAccess is true when the hub says the thing is missing or not yours; it never says which.
func NoAccess(err error) bool {
	var ae *APIError
	if !errors.As(err, &ae) {
		return false
	}
	return ae.Status == http.StatusNotFound || ae.Status == http.StatusForbidden || ae.Code == "NOT_FOUND" || ae.Code == "FORBIDDEN"
}

// Unauthorized is true when the token is expired, revoked or unknown.
func Unauthorized(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && (ae.Status == http.StatusUnauthorized || ae.Code == "UNAUTHORIZED")
}

type Client struct {
	base   string
	bearer string
	http   *http.Client

	mu      sync.Mutex
	expiry  time.Time // when the token stops working; zero when the hub does not say
	checked time.Time // when the expiry was last asked
}

// ParseHubURL accepts an https origin; plain http only when allowPlain is set.
func ParseHubURL(raw string, allowPlain bool) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", errors.New("invalid hub address")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && allowPlain) {
		return "", errors.New("the hub address must be https (plain http would send the token in the clear)")
	}
	return u.Scheme + "://" + u.Host, nil
}

func NormalizeFingerprint(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimPrefix(s, "sha256:")
	s = strings.NewReplacer(":", "", " ", "").Replace(s)
	if b, err := hex.DecodeString(s); err != nil || len(b) != 32 {
		return "", errors.New("fingerprint must be a SHA-256 value (64 hex characters)")
	}
	return s, nil
}

func NewClient(base, bearer string, opts TLSOptions) (*Client, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	switch {
	case opts.Fingerprint != "":
		want, err := NormalizeFingerprint(opts.Fingerprint)
		if err != nil {
			return nil, err
		}
		// A pin replaces chain verification: only that exact certificate is accepted.
		cfg.InsecureSkipVerify = true
		cfg.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("hub presented no certificate")
			}
			sum := sha256.Sum256(raw[0])
			if hex.EncodeToString(sum[:]) != want {
				return errors.New("hub certificate does not match the pinned fingerprint")
			}
			return nil
		}
	case opts.Insecure:
		cfg.InsecureSkipVerify = true
	case len(opts.CAPEM) > 0:
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(opts.CAPEM) {
			return nil, errors.New("the CA bundle contains no certificate")
		}
		cfg.RootCAs = pool
	}
	return &Client{
		base:   strings.TrimRight(base, "/"),
		bearer: bearer,
		http: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig:     cfg,
				Proxy:               http.ProxyFromEnvironment,
				ForceAttemptHTTP2:   true,
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     60 * time.Second, // never keep a connection open indefinitely
			},
			// Never follow a redirect: it would carry the bearer token somewhere else.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// CloseIdle drops pooled connections; call it when a client is retired.
// expiryTTL is how long an answer is kept: a manager can extend a token on the hub, and the new date should show without a restart.
const expiryTTL = time.Hour

// Expiry says when the token stops working. It asks the hub at most once an hour; a hub that does
// not report it, or a failed ask, gives ok=false and is no error.
func (c *Client) Expiry(ctx context.Context) (t time.Time, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.checked.IsZero() || time.Since(c.checked) > expiryTTL {
		var out struct {
			ExpiresAt string `json:"expiresAt"`
		}
		if err := c.call(ctx, "me", nil, &out); err != nil {
			return time.Time{}, false
		}
		c.checked = time.Now()
		if parsed, err := time.Parse(time.RFC3339, out.ExpiresAt); err == nil {
			c.expiry = parsed
		}
	}
	return c.expiry, !c.expiry.IsZero()
}

func (c *Client) CloseIdle() { c.http.CloseIdleConnections() }

func (c *Client) call(ctx context.Context, procedure string, in, out any) error {
	body, err := json.Marshal(map[string]any{"json": in})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/rpc/"+procedure, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+c.bearer)
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach the hub: %w", unwrapURLError(err))
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		return errors.New("the hub redirected the request; use its https address")
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponse))
	if err != nil {
		return err
	}
	var envelope struct {
		JSON json.RawMessage `json:"json"`
	}
	_ = json.Unmarshal(raw, &envelope)
	if res.StatusCode >= 400 {
		ae := &APIError{Status: res.StatusCode}
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(envelope.JSON, &e) == nil {
			ae.Code, ae.Message = e.Code, e.Message
		}
		return ae
	}
	if len(envelope.JSON) == 0 {
		return errors.New("unexpected reply from the hub")
	}
	return json.Unmarshal(envelope.JSON, out)
}

// unwrapURLError drops the URL (it can't hold secrets here, but the message reads better).
func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// EnvRow is one environment you can open, as `environments/list` reports it.
type EnvRow struct {
	Name          string `json:"name"`
	UpdatedAt     string `json:"updatedAt"`
	Level         string `json:"level"`
	WrappedEnvDek string `json:"wrappedEnvDek"`
	KeyVersion    int    `json:"keyVersion"`
	RotatePending bool   `json:"rotatePending"`
}

func (c *Client) ListEnvironments(ctx context.Context, tenantID, project string) ([]EnvRow, error) {
	var rows []EnvRow
	err := c.call(ctx, "environments/list", map[string]string{"tenantId": tenantID, "project": project}, &rows)
	return rows, err
}

type EnvPayload struct {
	TenantID    string    `json:"tenantId"`
	ProjectName string    `json:"projectName"`
	Name        string    `json:"name"`
	UpdatedAt   string    `json:"updatedAt"`
	Payload     SealedBox `json:"payload"`
}

func (c *Client) GetEnv(ctx context.Context, tenantID, project, name string) (*EnvPayload, error) {
	var out EnvPayload
	err := c.call(ctx, "environments/getEnv", map[string]string{"tenantId": tenantID, "project": project, "name": name}, &out)
	return &out, err
}

// Find returns the row for one environment, or a no-access error: the hub never says whether
// it is missing or hidden.
func (c *Client) Find(ctx context.Context, tok *Token, project, env string) (*EnvRow, error) {
	rows, err := c.ListEnvironments(ctx, tok.W, project)
	if err != nil {
		return nil, err
	}
	want := strings.ToLower(strings.TrimSpace(env))
	for i := range rows {
		if rows[i].Name == want {
			return &rows[i], nil
		}
	}
	return nil, &APIError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "environment not found, or not shared with this token"}
}

// Open downloads and decrypts the environment `row` describes. The location is checked against
// what the hub echoes and the AAD is built from what was asked for, so a hub cannot hand over
// another environment's payload.
func (c *Client) Open(ctx context.Context, tok *Token, project string, row *EnvRow) (map[string]string, error) {
	dek, err := UnwrapDEK(row.WrappedEnvDek, tok.K)
	if err != nil {
		return nil, &DecryptError{err}
	}
	got, err := c.GetEnv(ctx, tok.W, project, row.Name)
	if err != nil {
		return nil, err
	}
	if got.TenantID != tok.W || got.ProjectName != project || got.Name != row.Name {
		return nil, &DecryptError{errors.New("the hub returned a different location than requested")}
	}
	values, err := OpenEnv(got.Payload, dek, EnvAAD(tok.W, project, row.Name))
	if err != nil {
		return nil, &DecryptError{err}
	}
	return values, nil
}

// DecryptError means the data arrived but could not be opened (wrong key, wrong location, tampering).
type DecryptError struct{ error }

func (e *DecryptError) Unwrap() error { return e.error }

// Read is Find followed by Open.
func (c *Client) Read(ctx context.Context, tok *Token, project, env string) (map[string]string, *EnvRow, error) {
	row, err := c.Find(ctx, tok, project, env)
	if err != nil {
		return nil, nil, err
	}
	values, err := c.Open(ctx, tok, project, row)
	return values, row, err
}

// SaveEnv replaces an environment's payload. `base` is the updatedAt the caller last saw: the hub
// refuses the write (CONFLICT) if anyone saved since, so a push never silently overwrites a change.
func (c *Client) SaveEnv(ctx context.Context, tok *Token, project, name string, box SealedBox, base, note string) (string, error) {
	in := map[string]any{"tenantId": tok.W, "project": project, "name": name, "payload": box, "baseUpdatedAt": base}
	if note != "" {
		in["note"] = note
	}
	var out struct {
		UpdatedAt string `json:"updatedAt"`
	}
	err := c.call(ctx, "environments/saveEnv", in, &out)
	return out.UpdatedAt, err
}

// Conflict reports that the hub refused a write because the environment changed meanwhile.
func Conflict(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == "CONFLICT"
}

// SealFor encrypts values for the environment `row` describes.
func SealFor(tok *Token, project string, row *EnvRow, values map[string]string) (SealedBox, error) {
	dek, err := UnwrapDEK(row.WrappedEnvDek, tok.K)
	if err != nil {
		return SealedBox{}, &DecryptError{err}
	}
	return SealEnv(values, dek, EnvAAD(tok.W, project, row.Name))
}

// AgentLink is one link the hub asks this cluster to carry out.
type AgentLink struct {
	ID          string `json:"id"`
	Project     string `json:"project"`
	Environment string `json:"environment"`
	Namespace   string `json:"namespace"`
	SecretName  string `json:"secretName"`
	Direction   string `json:"direction"` // pull or push
	Adopt       bool   `json:"adopt"`     // a pull may take over a Secret that already exists
}

// AgentReport is what the operator tells the hub about a link: a short status, never values.
type AgentReport struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Message  string `json:"message"`
	KeyCount int    `json:"keyCount"`
}

// AgentSync says the operator is alive and which namespaces it may use, and returns its links.
func (c *Client) AgentSync(ctx context.Context, version string, namespaces []string, tokenExpires time.Time) ([]AgentLink, error) {
	if namespaces == nil {
		namespaces = []string{}
	}
	expires := ""
	if !tokenExpires.IsZero() {
		expires = tokenExpires.UTC().Format(time.RFC3339)
	}
	var out []AgentLink
	err := c.call(ctx, "k8s/agent/sync", map[string]any{"version": version, "namespaces": namespaces, "tokenExpiresAt": expires}, &out)
	return out, err
}

func (c *Client) AgentReport(ctx context.Context, reports []AgentReport) error {
	// The hub takes at most 500 statuses a call; an operator with more links than that (or one catching
	// up after an outage) would otherwise be refused every time and never report anything.
	for len(reports) > 0 {
		n := min(len(reports), reportBatch)
		if err := c.call(ctx, "k8s/agent/report", map[string]any{"reports": reports[:n]}, &struct{}{}); err != nil {
			return err
		}
		reports = reports[n:]
	}
	return nil
}

// reportBatch stays under the hub's limit of 500 statuses per report call.
const reportBatch = 400
