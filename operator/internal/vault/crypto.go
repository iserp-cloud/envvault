package vault

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// SealedBox is an AES-256-GCM box: base64url iv (12 bytes) and ciphertext||tag.
type SealedBox struct {
	V  int    `json:"v"`
	IV string `json:"iv"`
	CT string `json:"ct"`
}

// EnvAAD binds a ciphertext to its location. Build it from the location you asked for,
// never from what the hub says it returned.
func EnvAAD(tenantID, project, env string) string {
	return "envvault:env:v1|" + tenantID + "|" + project + "|" + env
}

func b64url(s string) ([]byte, error) {
	for len(s)%4 != 0 {
		s += "="
	}
	return base64.URLEncoding.DecodeString(s)
}

// UnwrapDEK opens an RSA-OAEP(SHA-256) wrapped environment key with the token's private key.
// The unwrapped bytes are themselves base64url text of the 32-byte AES key.
func UnwrapDEK(wrappedB64, privateKeyPKCS8B64 string) ([]byte, error) {
	der, err := base64.StdEncoding.DecodeString(privateKeyPKCS8B64)
	if err != nil {
		return nil, errors.New("invalid private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, errors.New("invalid private key")
	}
	priv, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not RSA")
	}
	wrapped, err := base64.StdEncoding.DecodeString(wrappedB64)
	if err != nil {
		return nil, errors.New("invalid wrapped key")
	}
	text, err := rsa.DecryptOAEP(sha256.New(), nil, priv, wrapped, nil)
	if err != nil {
		return nil, errors.New("could not unwrap the environment key")
	}
	dek, err := b64url(string(text))
	if err != nil || len(dek) != 32 {
		return nil, errors.New("environment key has the wrong shape")
	}
	return dek, nil
}

// DefaultGroup is the group of every key that has none. It is never stored on a key.
const DefaultGroup = "default"

var groupRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// ValidGroup reports whether name is usable as a key group (and is not the default group, which is implied).
func ValidGroup(name string) bool { return name != DefaultGroup && groupRE.MatchString(name) }

// NormalizeGroup maps what a link or a person wrote to the stored form: lower case, and "" for the default group.
func NormalizeGroup(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == DefaultGroup {
		return ""
	}
	return name
}

// MaxLabels is the most group names one environment's registry may hold.
const MaxLabels = 50

// Env is an opened environment: its variables, the group of each key that is not in the default group, and
// the registry of group names the dashboard offers (it may list names no key uses yet; the operator only
// keeps it intact when it saves).
type Env struct {
	Vars   map[string]string
	Groups map[string]string
	Labels []string
}

// GroupOf returns the group of one key, DefaultGroup when it has none.
func (e Env) GroupOf(key string) string {
	if g := e.Groups[key]; g != "" {
		return g
	}
	return DefaultGroup
}

// Group returns a copy of the keys in one group. "" and "default" both mean the keys that have no group.
func (e Env) Group(name string) map[string]string {
	want := NormalizeGroup(name)
	if want == "" {
		want = DefaultGroup
	}
	out := map[string]string{}
	for k, v := range e.Vars {
		if e.GroupOf(k) == want {
			out[k] = v
		}
	}
	return out
}

// HasGroups reports whether the environment uses groups at all: a key in a named group, or a registered name.
// A caller that cannot carry them through a save must refuse such an environment.
func (e Env) HasGroups() bool { return len(e.Groups) > 0 || len(e.Labels) > 0 }

// cleanLabels is the registry as it is stored: valid names only, unique and sorted, at most MaxLabels.
func cleanLabels(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range in {
		l = strings.ToLower(strings.TrimSpace(l))
		if ValidGroup(l) && !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	sort.Strings(out)
	if len(out) > MaxLabels {
		out = out[:MaxLabels]
	}
	return out
}

func textMap(v any, what string) (map[string]string, error) {
	raw, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("corrupt environment payload: %s is not an object", what)
	}
	out := make(map[string]string, len(raw))
	for k, x := range raw {
		s, ok := x.(string)
		if !ok {
			return nil, fmt.Errorf("corrupt environment payload: value of %q is not a string", k)
		}
		out[k] = s
	}
	return out, nil
}

// OpenEnvData decrypts an environment payload. Any failure is final: callers must not write partial
// results. The plaintext is either a plain object of strings (no groups) or {"v":2,"vars":{…},"groups":{…}}.
func OpenEnvData(box SealedBox, dek []byte, aad string) (Env, error) {
	if box.V != 1 {
		return Env{}, errors.New("unsupported ciphertext version")
	}
	iv, err := b64url(box.IV)
	if err != nil || len(iv) != 12 {
		return Env{}, errors.New("invalid ciphertext")
	}
	ct, err := b64url(box.CT)
	if err != nil {
		return Env{}, errors.New("invalid ciphertext")
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return Env{}, err
	}
	gcm, err := cipher.NewGCMWithTagSize(block, 16)
	if err != nil {
		return Env{}, err
	}
	plain, err := gcm.Open(nil, iv, ct, []byte(aad))
	if err != nil {
		return Env{}, errors.New("could not decrypt the environment (wrong key, location or tampered data)")
	}
	var raw map[string]any
	if err := json.Unmarshal(plain, &raw); err != nil || raw == nil {
		return Env{}, errors.New("corrupt environment payload")
	}
	// A plain environment holds only strings, so a numeric "v" can only be the grouped shape.
	if v, isNum := raw["v"].(float64); isNum {
		if v != 2 {
			return Env{}, errors.New("this environment was saved by a newer EnvVault; update the operator")
		}
		vars, err := textMap(raw["vars"], "vars")
		if err != nil {
			return Env{}, err
		}
		groups := map[string]string{}
		if g, present := raw["groups"]; present {
			if groups, err = textMap(g, "groups"); err != nil {
				return Env{}, err
			}
		}
		for k, g := range groups {
			if _, ok := vars[k]; !ok || !ValidGroup(g) {
				return Env{}, errors.New("corrupt environment payload: groups")
			}
		}
		var labels []string
		if l, present := raw["labels"]; present {
			list, ok := l.([]any)
			if !ok || len(list) > MaxLabels {
				return Env{}, errors.New("corrupt environment payload: labels")
			}
			seen := map[string]bool{}
			for _, x := range list {
				name, ok := x.(string)
				if !ok || !ValidGroup(name) || seen[name] {
					return Env{}, errors.New("corrupt environment payload: labels")
				}
				seen[name] = true
				labels = append(labels, name)
			}
		}
		return Env{Vars: vars, Groups: groups, Labels: labels}, nil
	}
	vars, err := textMap(raw, "values")
	if err != nil {
		return Env{}, err
	}
	return Env{Vars: vars, Groups: map[string]string{}}, nil
}

// OpenEnv is OpenEnvData for callers that only handle plain environments: it refuses one that has groups
// instead of silently dropping them.
func OpenEnv(box SealedBox, dek []byte, aad string) (map[string]string, error) {
	env, err := OpenEnvData(box, dek, aad)
	if err != nil {
		return nil, err
	}
	if env.HasGroups() {
		return nil, errors.New("this environment has key groups, which this caller cannot handle")
	}
	return env.Vars, nil
}

// SealEnvData encrypts an environment the way the TypeScript clients do: a JSON object with sorted
// keys (the plain shape when no key has a group, {"v":2,…} otherwise), AES-256-GCM under the
// environment key, a fresh random IV, the location bound as AAD.
func SealEnvData(env Env, dek []byte, aad string) (SealedBox, error) {
	groups := map[string]string{}
	for k, g := range env.Groups {
		if _, ok := env.Vars[k]; ok && NormalizeGroup(g) != "" {
			groups[k] = NormalizeGroup(g)
		}
	}
	labels := cleanLabels(env.Labels)
	var body any = env.Vars
	if len(groups) > 0 || len(labels) > 0 {
		body = struct {
			V      int               `json:"v"`
			Vars   map[string]string `json:"vars"`
			Groups map[string]string `json:"groups"`
			Labels []string          `json:"labels,omitempty"`
		}{2, env.Vars, groups, labels}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil { // map keys are written sorted
		return SealedBox{}, err
	}
	plain := bytes.TrimRight(buf.Bytes(), "\n")
	block, err := aes.NewCipher(dek)
	if err != nil {
		return SealedBox{}, err
	}
	gcm, err := cipher.NewGCMWithTagSize(block, 16)
	if err != nil {
		return SealedBox{}, err
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return SealedBox{}, err
	}
	ct := gcm.Seal(nil, iv, plain, []byte(aad))
	return SealedBox{V: 1, IV: base64.RawURLEncoding.EncodeToString(iv), CT: base64.RawURLEncoding.EncodeToString(ct)}, nil
}

// SealEnv seals a plain environment (no groups).
func SealEnv(values map[string]string, dek []byte, aad string) (SealedBox, error) {
	return SealEnvData(Env{Vars: values}, dek, aad)
}
