// Package vault is the read-only half of the EnvVault protocol (docs/protocol.md, schema zk-6):
// decode a service token, ask the hub for an environment, and open it. It never encrypts,
// wraps or creates anything.
package vault

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

const tokenPrefix = "evt_"

// Token is a decoded service token. K is the private key and T the bearer token: never log either.
type Token struct {
	V int    `json:"v"`
	U string `json:"u"` // service account username
	T string `json:"t"` // bearer token for the hub
	K string `json:"k"` // RSA private key, PKCS8, base64
	W string `json:"w"` // workspace (tenant) id
	R string `json:"r"` // hub origin
}

// String keeps credentials out of logs and error messages.
func (t Token) String() string { return "service-token(" + t.U + ")" }

func DecodeToken(raw string) (*Token, error) {
	s := strings.TrimSpace(raw)
	if !strings.HasPrefix(s, tokenPrefix) {
		return nil, errors.New("not an EnvVault service token")
	}
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s[len(tokenPrefix):], "="))
	if err != nil {
		return nil, errors.New("malformed service token")
	}
	var t Token
	if err := json.Unmarshal(body, &t); err != nil {
		return nil, errors.New("malformed service token")
	}
	if t.V != 1 || t.U == "" || t.T == "" || t.K == "" || t.W == "" || t.R == "" {
		return nil, errors.New("malformed service token")
	}
	return &t, nil
}
