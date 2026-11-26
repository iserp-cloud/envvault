package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"sync"
	"time"

	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

const clientIdle = 10 * time.Minute

type cachedClient struct {
	c    *vault.Client
	used time.Time
}

// clientCache reuses one hub client (and its connections) per hub, token and trust setting,
// instead of building a new one for every reconcile. Clients nobody has asked for in a while
// are closed, so rotated tokens don't pile up.
type clientCache struct {
	mu sync.Mutex
	m  map[string]*cachedClient
}

func (cc *clientCache) get(base, bearer string, opts vault.TLSOptions) (*vault.Client, error) {
	h := sha256.New()
	for _, part := range []string{base, bearer, opts.Fingerprint, strconv.FormatBool(opts.Insecure), string(opts.CAPEM)} {
		h.Write([]byte(strconv.Itoa(len(part)) + ":" + part))
	}
	key := hex.EncodeToString(h.Sum(nil))

	cc.mu.Lock()
	defer cc.mu.Unlock()
	now := time.Now()
	for k, e := range cc.m {
		if k != key && now.Sub(e.used) > clientIdle {
			e.c.CloseIdle()
			delete(cc.m, k)
		}
	}
	if e, ok := cc.m[key]; ok {
		e.used = now
		return e.c, nil
	}
	c, err := vault.NewClient(base, bearer, opts)
	if err != nil {
		return nil, err
	}
	if cc.m == nil {
		cc.m = map[string]*cachedClient{}
	}
	cc.m[key] = &cachedClient{c: c, used: now}
	return c, nil
}
