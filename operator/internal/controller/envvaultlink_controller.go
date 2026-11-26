package controller

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	"sigs.k8s.io/controller-runtime/pkg/source"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

// LinkLabel marks a Secret that a hub link writes, and says which link. It is how the operator
// recognises its own Secret (a link has no custom resource to own it).
const LinkLabel = "envvault.io/hub-link"

// resendEvery is how often every link's status is sent again even if it has not changed.
const resendEvery = 5 * time.Minute

// reasonNamespace is reported when the hub links a namespace this operator is not allowed to use.
const reasonNamespace = "NamespaceNotAllowed"

// LinkReconciler carries out the links made in the dashboard. The hub only stores the mapping;
// this decrypts and writes with a cluster token that the dashboard granted access to each linked
// environment. It runs only in the namespaces it was started with, whatever the hub asks for.
type LinkReconciler struct {
	R *Reconciler
	P *PushReconciler

	TokenSecret    types.NamespacedName // the cluster token (key "token")
	HubURL         string               // overrides the address in the token
	TLS            vault.TLSOptions
	AllowPlainHTTP bool
	Config         types.NamespacedName // optional ConfigMap limiting the namespaces links may use (key "namespaces")
	Interval       time.Duration
	Version        string

	nsMu       sync.RWMutex
	limit      []string // namespaces links may use; "*" means all
	liveURL    string   // hub address from the ConfigMap; wins over --hub-url and the one in the token
	livePin    string   // hub certificate fingerprint from the ConfigMap; wins over --hub-fingerprint
	limitKnown bool     // false until the first successful read of the ConfigMap

	mu       sync.Mutex
	tok      *vault.Token
	hub      *vault.Client
	links    map[string]vault.AgentLink
	byTarget map[string]string // namespace/name -> link id
	push     map[string]*pushState
	failures map[string]int
	reports  map[string]vault.AgentReport // latest per link
	sent     map[string]vault.AgentReport // last accepted by the hub
	resent   time.Time                    // when everything was last re-sent regardless of change
	events   chan event.TypedGenericEvent[*metav1.PartialObjectMetadata]
}

type pushState struct{ observed, digest string }

func (l *LinkReconciler) init() {
	l.links = map[string]vault.AgentLink{}
	l.byTarget = map[string]string{}
	l.push = map[string]*pushState{}
	l.failures = map[string]int{}
	l.reports = map[string]vault.AgentReport{}
	l.sent = map[string]vault.AgentReport{}
	l.events = make(chan event.TypedGenericEvent[*metav1.PartialObjectMetadata], 256)
	if l.Interval <= 0 {
		l.Interval = 30 * time.Second
	}
}

// Keys of the optional ConfigMap that holds the settings which may change without reinstalling the operator.
const (
	NamespacesKey     = "namespaces"     // where links may write: comma separated, or "*"
	HubURLKey         = "hubUrl"         // the hub's address, if not the one in the cluster token
	HubFingerprintKey = "hubFingerprint" // SHA-256 of the hub's certificate, for a hub with its own certificate
)

// hubSettings is the hub address and pin in force: the ConfigMap's, else the flags'.
func (l *LinkReconciler) hubSettings() (addr string, tls vault.TLSOptions) {
	l.nsMu.RLock()
	defer l.nsMu.RUnlock()
	addr, tls = l.HubURL, l.TLS
	if l.liveURL != "" {
		addr = l.liveURL
	}
	if l.livePin != "" {
		tls.Fingerprint = l.livePin
	}
	return addr, tls
}

func (l *LinkReconciler) setHub(url, pin string) {
	l.nsMu.Lock()
	l.liveURL, l.livePin = url, pin
	l.nsMu.Unlock()
}

func (l *LinkReconciler) namespaces() []string {
	l.nsMu.RLock()
	defer l.nsMu.RUnlock()
	if !l.limitKnown {
		return nil // fail closed until the restriction has been read once
	}
	return l.limit
}

func (l *LinkReconciler) allowed(ns string) bool {
	list := l.namespaces()
	return slices.Contains(list, "*") || slices.Contains(list, ns)
}

func (l *LinkReconciler) setNamespaces(list []string) (changed bool) {
	slices.Sort(list)
	l.nsMu.Lock()
	defer l.nsMu.Unlock()
	changed = l.limitKnown && !slices.Equal(l.limit, list)
	l.limit, l.limitKnown = list, true
	return changed
}

// refreshConfig reads the ConfigMap. For the restriction: no ConfigMap, or no key in it, means every
// namespace; a key that is present but empty means none. The hub address and pin it may carry replace
// the flags'. A read that fails for any other reason keeps what was known (and allows nothing if
// nothing was ever known). It reports whether the namespace list changed.
func (l *LinkReconciler) refreshConfig(ctx context.Context) bool {
	if l.Config.Name == "" {
		return false
	}
	var cm corev1.ConfigMap
	switch err := l.R.APIReader.Get(ctx, l.Config, &cm); {
	case apierrors.IsNotFound(err):
		l.setHub("", "")
		return l.setNamespaces([]string{"*"})
	case err != nil:
		logf.FromContext(ctx).WithName("links").Info("cannot read the namespace restriction; keeping the last one", "configmap", l.Config.String(), "error", err.Error())
		return false
	}
	l.setHub(strings.TrimSpace(cm.Data[HubURLKey]), strings.TrimSpace(cm.Data[HubFingerprintKey]))
	value, ok := cm.Data[NamespacesKey]
	if !ok {
		return l.setNamespaces([]string{"*"})
	}
	var list []string
	for _, n := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }) {
		list = append(list, n)
	}
	return l.setNamespaces(list)
}

func (l *LinkReconciler) SetupWithManager(mgr ctrl.Manager) error {
	l.init()
	if err := mgr.Add(l); err != nil { // the poll loop
		return err
	}
	return ctrl.NewControllerManagedBy(mgr).
		Named("envvaultlink").
		WatchesRawSource(source.Channel(l.events, handler.TypedEnqueueRequestsFromMapFunc(
			func(_ context.Context, o *metav1.PartialObjectMetadata) []reconcile.Request {
				return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: o.Name}}}
			}))).
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(l.linksFor)).
		WithOptions(controller.Options{MaxConcurrentReconciles: max(l.R.Concurrency, 1)}).
		Complete(l)
}

// linksFor maps an edited Secret to the push link that reads it, so the edit goes up at once.
func (l *LinkReconciler) linksFor(_ context.Context, obj client.Object) []reconcile.Request {
	if obj.GetLabels()[ManagedByLabel] != PushSourceValue {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if id, ok := l.byTarget[obj.GetNamespace()+"/"+obj.GetName()]; ok && l.links[id].Direction == "push" {
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: id}}}
	}
	return nil
}

// Start runs the poll loop: ask the hub for the links, start and stop work to match, report back.
func (l *LinkReconciler) Start(ctx context.Context) error {
	log := logf.FromContext(ctx).WithName("links")
	t := time.NewTicker(l.Interval)
	defer t.Stop()
	waiting := false
	for {
		if err := l.poll(ctx); err != nil {
			if l.tokenMissing(ctx) {
				// Not an error: this cluster simply has no dashboard links (yet). Say so once.
				if !waiting {
					log.Info("no cluster token Secret yet, so dashboard links are off until it exists", "secret", l.TokenSecret.String())
					waiting = true
				}
			} else {
				waiting = false
				log.Info("could not ask the hub for links; keeping what is running", "error", err.Error())
			}
		} else {
			waiting = false
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// tokenMissing is true when the cluster token Secret does not exist.
func (l *LinkReconciler) tokenMissing(ctx context.Context) bool {
	return apierrors.IsNotFound(l.R.APIReader.Get(ctx, l.TokenSecret, &corev1.Secret{}))
}

func (l *LinkReconciler) connect(ctx context.Context) (*vault.Token, *vault.Client, error) {
	raw, serr := l.R.secretValue(ctx, l.TokenSecret.Namespace, v1.SecretKeyRef{Name: l.TokenSecret.Name}, "token")
	if serr != nil {
		return nil, nil, serr
	}
	tok, err := vault.DecodeToken(string(raw))
	if err != nil {
		return nil, nil, err
	}
	addr, tlsOpts := l.hubSettings()
	if addr == "" {
		addr = tok.R
	}
	base, err := vault.ParseHubURL(addr, l.AllowPlainHTTP)
	if err != nil {
		return nil, nil, err
	}
	c, err := l.R.clients.get(base, tok.T, tlsOpts)
	return tok, c, err
}

// visibleNamespaces is what the dashboard may offer: the allow-list, or every namespace for "*".
func (l *LinkReconciler) visibleNamespaces(ctx context.Context) []string {
	limit := l.namespaces()
	if !slices.Contains(limit, "*") {
		return limit
	}
	var list corev1.NamespaceList
	if err := l.R.APIReader.List(ctx, &list); err != nil {
		return nil
	}
	out := make([]string, 0, len(list.Items))
	for _, n := range list.Items {
		out = append(out, n.Name)
	}
	slices.Sort(out)
	return out
}

func (l *LinkReconciler) poll(ctx context.Context) error {
	restricted := l.refreshConfig(ctx)
	tok, hub, err := l.connect(ctx)
	if err != nil {
		return err
	}
	expires, _ := hub.Expiry(ctx)
	links, err := hub.AgentSync(ctx, l.Version, l.visibleNamespaces(ctx), expires)
	if err != nil {
		return err
	}

	l.mu.Lock()
	// The hub's copy of a status can differ from what was last accepted (a new token took the links
	// over, or the hub was restored), and "unchanged" would then never correct it. So a new identity,
	// and every few minutes anyway, sends everything again.
	if (l.tok != nil && l.tok.U != tok.U) || time.Since(l.resent) > resendEvery {
		l.sent = map[string]vault.AgentReport{}
		l.resent = time.Now()
	}
	l.tok, l.hub = tok, hub
	next := make(map[string]vault.AgentLink, len(links))
	var start []string
	for _, k := range links {
		next[k.ID] = k
		if old, ok := l.links[k.ID]; !ok || old != k {
			start = append(start, k.ID)
		}
	}
	if restricted {
		// The restriction changed: every link is looked at again, so one that is now outside it says so
		// and one that is inside it again starts.
		for id := range next {
			if !slices.Contains(start, id) {
				start = append(start, id)
			}
		}
	}
	var gone []vault.AgentLink
	for id, k := range l.links {
		if _, ok := next[id]; !ok {
			gone = append(gone, k)
			delete(l.push, id)
			delete(l.failures, id)
			delete(l.reports, id)
			delete(l.sent, id)
		}
	}
	l.links = next
	l.byTarget = make(map[string]string, len(next))
	for id, k := range next {
		l.byTarget[k.Namespace+"/"+k.SecretName] = id
	}
	var pending []vault.AgentReport
	for id, r := range l.reports {
		if l.sent[id] != r {
			pending = append(pending, r)
		}
	}
	l.mu.Unlock()

	for _, id := range start {
		if !l.enqueue(ctx, id) {
			return ctx.Err()
		}
	}
	for _, k := range gone {
		l.release(ctx, k)
	}
	if len(pending) > 0 {
		if err := hub.AgentReport(ctx, pending); err != nil {
			return err
		}
		l.mu.Lock()
		for _, r := range pending {
			if _, live := l.links[r.ID]; live {
				l.sent[r.ID] = r
			}
		}
		l.mu.Unlock()
	}
	return nil
}

// enqueue waits for room rather than dropping the event: a link is only started when it is new or
// changed, so one dropped here would sit untouched until someone edited it. The controller drains the
// channel as fast as it fills, so the wait is short even for hundreds of links in one poll.
func (l *LinkReconciler) enqueue(ctx context.Context, id string) bool {
	obj := &metav1.PartialObjectMetadata{ObjectMeta: metav1.ObjectMeta{Name: id}}
	select {
	case l.events <- event.TypedGenericEvent[*metav1.PartialObjectMetadata]{Object: obj}:
		return true
	case <-ctx.Done():
		return false
	}
}

// releaseStale frees a Secret that is still labelled for a link which no longer exists. That
// happens when a link was removed while this operator was not running its link controller (an
// older image, a restart), so nothing released it. The label then names no owner; the Secret is an
// ordinary one again, and the take-over rule decides whether this link may have it.
func (l *LinkReconciler) releaseStale(ctx context.Context, k vault.AgentLink) {
	var s corev1.Secret
	if err := l.R.APIReader.Get(ctx, types.NamespacedName{Namespace: k.Namespace, Name: k.SecretName}, &s); err != nil {
		return
	}
	owner := s.Labels[LinkLabel]
	if owner == "" || owner == k.ID {
		return
	}
	l.mu.Lock()
	_, live := l.links[owner]
	l.mu.Unlock()
	if live {
		return
	}
	orig := s.DeepCopy()
	delete(s.Labels, LinkLabel)
	if s.Labels[ManagedByLabel] == ManagedByValue {
		delete(s.Labels, ManagedByLabel)
	}
	if err := l.R.Patch(ctx, &s, client.MergeFrom(orig)); err != nil && !apierrors.IsNotFound(err) {
		logf.FromContext(ctx).Info("could not release a Secret of a link that no longer exists", "secret", k.Namespace+"/"+k.SecretName, "error", err.Error())
		return
	}
	logf.FromContext(ctx).Info("the link that owned this Secret no longer exists; it counts as released", "secret", k.Namespace+"/"+k.SecretName, "was", owner)
}

// releaseSource takes the push-source mark off the Secret of a push link that was removed. Left
// behind, the mark would make every later link to that Secret fail as "belongs to something else",
// and no take-over could change that. A Secret that an EnvVaultPush resource still uses keeps it.
func (l *LinkReconciler) releaseSource(ctx context.Context, k vault.AgentLink) {
	var s corev1.Secret
	if err := l.R.APIReader.Get(ctx, types.NamespacedName{Namespace: k.Namespace, Name: k.SecretName}, &s); err != nil {
		return
	}
	if s.Labels[ManagedByLabel] != PushSourceValue {
		return
	}
	var pushes v1.EnvVaultPushList
	if err := l.R.APIReader.List(ctx, &pushes, client.InNamespace(k.Namespace)); err == nil {
		for _, p := range pushes.Items {
			if p.Spec.SourceSecretName == k.SecretName {
				return
			}
		}
	}
	orig := s.DeepCopy()
	delete(s.Labels, ManagedByLabel)
	if err := l.R.Patch(ctx, &s, client.MergeFrom(orig)); err != nil && !apierrors.IsNotFound(err) {
		logf.FromContext(ctx).Info("could not release the source Secret of a removed push link", "secret", k.Namespace+"/"+k.SecretName, "error", err.Error())
		return
	}
	logf.FromContext(ctx).Info("push link removed; the Secret is left in place and no longer watched", "secret", k.Namespace+"/"+k.SecretName)
}

// release lets go of the Secret of a link that was removed in the dashboard. The Secret and its
// values stay (pods may depend on them) but stop being kept in step: it becomes an ordinary Secret.
func (l *LinkReconciler) release(ctx context.Context, k vault.AgentLink) {
	if !l.allowed(k.Namespace) {
		return
	}
	if k.Direction == "push" {
		l.releaseSource(ctx, k)
		return
	}
	if k.Direction != "pull" {
		return
	}
	var s corev1.Secret
	if err := l.R.APIReader.Get(ctx, types.NamespacedName{Namespace: k.Namespace, Name: k.SecretName}, &s); err != nil {
		return
	}
	if s.Labels[LinkLabel] != k.ID {
		return
	}
	orig := s.DeepCopy()
	delete(s.Labels, LinkLabel)
	delete(s.Labels, ManagedByLabel)
	if err := l.R.Patch(ctx, &s, client.MergeFrom(orig)); err != nil && !apierrors.IsNotFound(err) {
		logf.FromContext(ctx).Info("could not release a Secret of a removed link", "secret", k.Namespace+"/"+k.SecretName, "error", err.Error())
		return
	}
	logf.FromContext(ctx).Info("link removed; the Secret is left in place and no longer updated", "secret", k.Namespace+"/"+k.SecretName)
}

func (l *LinkReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	id := req.Name
	l.mu.Lock()
	k, ok := l.links[id]
	tok, hub := l.tok, l.hub
	st := l.push[id]
	if st == nil {
		st = &pushState{}
		l.push[id] = st
	}
	failures := l.failures[id]
	l.mu.Unlock()
	if !ok || tok == nil {
		return ctrl.Result{}, nil // removed, or not connected yet; the poll starts it again
	}

	var (
		wrote bool
		keys  int
		serr  *syncError
	)
	switch {
	case !l.allowed(k.Namespace):
		serr = fail(reasonNamespace, "this operator is not allowed to use the namespace %q", k.Namespace)
	case k.Direction == "push":
		var res *pushResult
		res, serr = l.P.pushPlanned(ctx, tok, hub, pushPlan{
			namespace: k.Namespace, project: k.Project, environment: k.Environment, source: k.SecretName,
			note:     fmt.Sprintf("Pushed by envvault-operator (link %s/%s)", k.Namespace, k.SecretName),
			observed: st.observed, digest: st.digest,
		})
		if serr == nil {
			st.observed, st.digest, keys, wrote = res.version, res.digest, res.keys, res.wrote
		}
	default:
		l.releaseStale(ctx, k)
		var res *syncResult
		res, serr = l.R.pull(ctx, tok, hub, pullPlan{
			namespace: k.Namespace, project: k.Project, environment: k.Environment, target: k.SecretName,
			adopt: k.Adopt,
			owns:  func(s *corev1.Secret) bool { return s.Labels[LinkLabel] == id },
			claim: func(s *corev1.Secret) error {
				s.Labels[LinkLabel] = id
				return nil
			},
		})
		if serr == nil {
			keys, wrote = res.keys, res.wrote
		}
	}

	report := vault.AgentReport{ID: id, Status: reasonSynced, Message: "Up to date", KeyCount: keys}
	if k.Direction == "push" {
		report.Status = reasonPushed
	}
	if serr != nil {
		failures++
		report.Status, report.Message, report.KeyCount = serr.reason, truncate(serr.err.Error(), 280), 0
		reconcileTotal.WithLabelValues("link", serr.reason).Inc()
		logf.FromContext(ctx).Info("link failed", "link", k.Namespace+"/"+k.SecretName, "reason", serr.reason, "error", serr.err.Error())
	} else {
		failures = 0
		reconcileTotal.WithLabelValues("link", "ok").Inc()
		if wrote {
			updatesTotal.WithLabelValues("link").Inc()
		}
	}
	l.mu.Lock()
	if _, still := l.links[id]; still {
		l.failures[id] = failures
		l.reports[id] = report
	}
	l.mu.Unlock()
	return ctrl.Result{RequeueAfter: jitter(backoff(defRefresh, failures))}, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
