package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var validKey = regexp.MustCompile(`^[-._a-zA-Z0-9]+$`)

// invalidKeys lists names a Kubernetes Secret cannot hold. Names are not secret; values never appear here.
func invalidKeys(values map[string]string) []string {
	var bad []string
	for k := range values {
		if len(k) > 253 || k == "." || k == ".." || strings.HasPrefix(k, "..") || !validKey.MatchString(k) {
			bad = append(bad, k)
		}
	}
	sort.Strings(bad)
	return bad
}

// digest is a stable hash of a Secret's data, used to notice edits made behind our back.
// It is stored next to the data it describes, so it reveals nothing new to whoever can read it.
func digest(data map[string][]byte) string {
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, k := range keys {
		fmt.Fprintf(h, "%d:%s%d:", len(k), k, len(data[k]))
		h.Write(data[k])
	}
	return hex.EncodeToString(h.Sum(nil))
}

func sortedStrings(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func toData(values map[string]string) map[string][]byte {
	out := make(map[string][]byte, len(values))
	for k, v := range values {
		out[k] = []byte(v)
	}
	return out
}
