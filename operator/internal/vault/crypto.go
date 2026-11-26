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

// OpenEnv decrypts an environment payload into its string map. Any failure is final: callers
// must not write partial results.
func OpenEnv(box SealedBox, dek []byte, aad string) (map[string]string, error) {
	if box.V != 1 {
		return nil, errors.New("unsupported ciphertext version")
	}
	iv, err := b64url(box.IV)
	if err != nil || len(iv) != 12 {
		return nil, errors.New("invalid ciphertext")
	}
	ct, err := b64url(box.CT)
	if err != nil {
		return nil, errors.New("invalid ciphertext")
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCMWithTagSize(block, 16)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, iv, ct, []byte(aad))
	if err != nil {
		return nil, errors.New("could not decrypt the environment (wrong key, location or tampered data)")
	}
	var raw map[string]any
	if err := json.Unmarshal(plain, &raw); err != nil || raw == nil {
		return nil, errors.New("corrupt environment payload")
	}
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("corrupt environment payload: value of %q is not a string", k)
		}
		out[k] = s
	}
	return out, nil
}

// SealEnv encrypts an environment the way the TypeScript clients do: a JSON object with sorted
// keys, AES-256-GCM under the environment key, a fresh random IV, the location bound as AAD.
func SealEnv(values map[string]string, dek []byte, aad string) (SealedBox, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(values); err != nil { // map keys are written sorted
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
