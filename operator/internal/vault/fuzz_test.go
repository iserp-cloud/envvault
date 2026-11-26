package vault

import (
	"bytes"
	"testing"
)

// The inputs below come from outside (a token a person pasted, a hub's reply, a URL in a spec),
// so none of them may panic, whatever they hold.

func FuzzDecodeToken(f *testing.F) {
	f.Add("evt_e30")
	f.Add("evt_")
	f.Add("")
	f.Add("evt_eyJ2IjoxLCJ1Ijoic3ZjIiwidCI6IngiLCJrIjoiLSIsInciOiJ0IiwiciI6Imh0dHBzOi8vaHViIn0")
	f.Fuzz(func(t *testing.T, raw string) { _, _ = DecodeToken(raw) })
}

func FuzzParseHubURL(f *testing.F) {
	for _, s := range []string{"https://hub.example.com", "http://x", "", "https://", "//a", "https://a b", "ftp://x", "https://[::1]:99/x?y#z"} {
		f.Add(s, false)
	}
	f.Fuzz(func(t *testing.T, raw string, plain bool) {
		if got, err := ParseHubURL(raw, plain); err == nil && got == "" {
			t.Fatalf("accepted %q but returned an empty address", raw)
		}
	})
}

func FuzzNormalizeFingerprint(f *testing.F) {
	f.Add("D0:8B:AA")
	f.Add("sha256:" + string(bytes.Repeat([]byte("ab"), 32)))
	f.Add("")
	f.Fuzz(func(t *testing.T, s string) { _, _ = NormalizeFingerprint(s) })
}

func FuzzUnwrapDEK(f *testing.F) {
	f.Add("AAAA", "AAAA")
	f.Add("", "")
	f.Fuzz(func(t *testing.T, wrapped, key string) { _, _ = UnwrapDEK(wrapped, key) })
}

func FuzzOpenEnv(f *testing.F) {
	dek := bytes.Repeat([]byte{7}, 32)
	good, _ := SealEnv(map[string]string{"A": "1"}, dek, "aad")
	f.Add(good.IV, good.CT, "aad")
	f.Add("", "", "")
	f.Add("AAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x")
	f.Fuzz(func(t *testing.T, iv, ct, aad string) {
		// Only a box sealed under this key and location can open (GCM cannot be forged by mutation),
		// and then it must hold exactly what was sealed. Everything else is refused, never a panic.
		got, err := OpenEnv(SealedBox{V: 1, IV: iv, CT: ct}, dek, aad)
		if err == nil && (len(got) != 1 || got["A"] != "1") {
			t.Fatalf("opened a box with unexpected content: %v", got)
		}
	})
}

func FuzzSealOpenRoundTrip(f *testing.F) {
	f.Add("KEY", "value")
	f.Add("a.b-c_d", "line1\nline2 \"quoted\" <tag> & é ")
	f.Fuzz(func(t *testing.T, k, v string) {
		dek := bytes.Repeat([]byte{9}, 32)
		box, err := SealEnv(map[string]string{k: v}, dek, "loc")
		if err != nil {
			return // e.g. invalid UTF-8 the encoder refuses; refusing is fine
		}
		got, err := OpenEnv(box, dek, "loc")
		if err != nil || len(got) != 1 {
			t.Fatalf("sealed but did not open: %v %v", got, err)
		}
		for gk, gv := range got {
			// JSON replaces invalid UTF-8 with U+FFFD, so compare only what is valid text.
			if validUTF8(k) && validUTF8(v) && (gk != k || gv != v) {
				t.Fatalf("round trip changed %q=%q into %q=%q", k, v, gk, gv)
			}
		}
	})
}

func validUTF8(s string) bool { return string([]rune(s)) == s }
