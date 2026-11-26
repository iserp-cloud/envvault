// Package controller reconciles EnvVaultSecret resources.
package controller

import (
	"context"
	"errors"
	"fmt"
	"k8s.io/client-go/tools/record"
	"math/rand/v2"
	"reflect"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

const (
	ManagedByLabel = "app.kubernetes.io/managed-by"
	// AdoptAnnotation, set to "true" on a Secret that already exists, lets an EnvVaultSecret or a hub
	// link take it over. The Secret's owner decides, in the cluster; nothing is overwritten otherwise.
	AdoptAnnotation = "envvault.io/adopt"
	ManagedByValue  = "envvault-operator"

	annSource  = "envvault.io/source-version" // hub version last written
	annDigest  = "envvault.io/data-digest"    // hash of the data we wrote
	annRolled  = "envvault.io/secret-version" // on a workload's pod template; changing it rolls the pods
	condReady  = "Ready"
	minRefresh = 10 * time.Second
	defRefresh = 60 * time.Second
	maxBackoff = 5 * time.Minute
)

// Reasons for the Ready condition.
const (
	reasonSynced        = "Synced"
	reasonMisconfigured = "Misconfigured"
	reasonTokenInvalid  = "TokenInvalid"
	reasonUnauthorized  = "Unauthorized"
	reasonNoAccess      = "NoAccess"
	reasonHubError      = "HubUnreachable"
	reasonDecrypt       = "DecryptFailed"
	reasonInvalidKeys   = "InvalidKeys"
	reasonConflict      = "TargetConflict"
	reasonRejected      = "Rejected"
	reasonRollout       = "RolloutFailed"
	reasonGroupEmpty    = "GroupEmpty"
)

const kindConfigMap = "ConfigMap"

type syncError struct {
	reason string
	err    error
}

func (e *syncError) Error() string { return e.err.Error() }

func fail(reason string, format string, args ...any) *syncError {
	return &syncError{reason: reason, err: fmt.Errorf(format, args...)}
}

// Reconciler keeps one Secret per EnvVaultSecret in step with the hub.
type Reconciler struct {
	client.Client
	// APIReader reads without the cache: the token and CA Secrets are not labelled, so they are
	// never cached (which keeps the operator from holding every Secret in the cluster in memory).
	APIReader client.Reader
	Scheme    *runtime.Scheme
	// Concurrency is how many resources reconcile at once (default 8). A hub that hangs holds a
	// worker for up to the request timeout, so one slow hub must not be able to stall the rest.
	Concurrency int
	// Recorder raises Kubernetes events (optional).
	Recorder record.EventRecorder

	clients clientCache
}

// +kubebuilder:rbac:groups=envvault.io,resources=envvaultsecrets,verbs=get;list;watch
// +kubebuilder:rbac:groups=envvault.io,resources=envvaultsecrets/status,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=secrets;configmaps,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list
// +kubebuilder:rbac:groups=apps,resources=deployments;statefulsets;daemonsets,verbs=get;patch

func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1.EnvVaultSecret{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Owns(&corev1.Secret{}).
		Owns(&corev1.ConfigMap{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: max(r.Concurrency, 1)}).
		Complete(r)
}

func refreshOf(cr *v1.EnvVaultSecret) time.Duration {
	d := defRefresh
	if cr.Spec.RefreshInterval != nil && cr.Spec.RefreshInterval.Duration > 0 {
		d = cr.Spec.RefreshInterval.Duration
	}
	if d < minRefresh {
		d = minRefresh
	}
	return d
}

// backoff doubles the wait with each failure in a row, from the refresh interval up to maxBackoff
// (or the interval itself, if that is longer). A resource that works again is polled normally at once.
func backoff(interval time.Duration, failures int) time.Duration {
	if failures <= 1 {
		return interval
	}
	d := interval
	for i := 1; i < failures && d < maxBackoff; i++ {
		d *= 2
	}
	return min(max(d, interval), max(maxBackoff, interval))
}

func jitter(d time.Duration) time.Duration {
	return d + time.Duration(rand.Int64N(int64(d)/10+1))
}

func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	var cr v1.EnvVaultSecret
	if err := r.Get(ctx, req.NamespacedName, &cr); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !cr.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}

	orig := cr.DeepCopy()
	started := time.Now()
	synced, serr := r.sync(ctx, &cr)
	wrote := serr == nil && synced.wrote
	warnExpiry(r.Recorder, &cr, cr.Status.TokenExpiresAt, &cr.Status.ExpiryWarnedDays, started)
	observe(r.Recorder, &cr, "secret", meta.FindStatusCondition(orig.Status.Conditions, condReady), serr, wrote, "Secret updated from the hub")
	took := time.Since(started).Round(time.Millisecond).String()
	cr.Status.ObservedGeneration = cr.Generation
	if serr != nil {
		cr.Status.ConsecutiveFailures++
		// Only the reason and a safe message reach the status; values never do.
		log.Info("sync failed", "reason", serr.reason, "error", serr.err.Error(), "took", took)
		meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
			Type: condReady, Status: metav1.ConditionFalse, Reason: serr.reason, Message: serr.err.Error(), ObservedGeneration: cr.Generation,
		})
	} else {
		cr.Status.ConsecutiveFailures = 0
		cr.Status.ObservedVersion = synced.version
		cr.Status.KeyCount = synced.keys
		if synced.wrote {
			now := metav1.Now()
			cr.Status.LastSyncTime = &now
			log.Info("secret updated", "target", synced.target, "keys", synced.keys)
		}
		meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
			Type: condReady, Status: metav1.ConditionTrue, Reason: reasonSynced, Message: "Secret is up to date", ObservedGeneration: cr.Generation,
		})
	}
	if !reflect.DeepEqual(orig.Status, cr.Status) {
		patched := time.Now()
		if err := r.Status().Patch(ctx, &cr, client.MergeFrom(orig)); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		log.V(1).Info("status written", "took", time.Since(patched).Round(time.Millisecond).String())
	}
	return ctrl.Result{RequeueAfter: jitter(backoff(refreshOf(&cr), cr.Status.ConsecutiveFailures))}, nil
}

type syncResult struct {
	version string
	keys    int
	wrote   bool
	target  string
}

func (r *Reconciler) secretValue(ctx context.Context, ns string, ref v1.SecretKeyRef, defKey string) ([]byte, *syncError) {
	key := ref.Key
	if key == "" {
		key = defKey
	}
	var s corev1.Secret
	if err := r.APIReader.Get(ctx, types.NamespacedName{Namespace: ns, Name: ref.Name}, &s); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, fail(reasonMisconfigured, "secret %q not found in this namespace", ref.Name)
		}
		return nil, fail(reasonMisconfigured, "cannot read secret %q: %v", ref.Name, err)
	}
	v, ok := s.Data[key]
	if !ok || len(v) == 0 {
		return nil, fail(reasonMisconfigured, "secret %q has no key %q", ref.Name, key)
	}
	return v, nil
}

func (r *Reconciler) hubClient(ctx context.Context, ns string, tokenRef v1.SecretKeyRef, hub v1.HubSpec) (*vault.Token, *vault.Client, *syncError) {
	raw, serr := r.secretValue(ctx, ns, tokenRef, "token")
	if serr != nil {
		return nil, nil, serr
	}
	tok, err := vault.DecodeToken(string(raw))
	if err != nil {
		return nil, nil, fail(reasonTokenInvalid, "%v", err)
	}
	addr := hub.URL
	if addr == "" {
		addr = tok.R
	}
	base, err := vault.ParseHubURL(addr, hub.AllowPlainHTTP)
	if err != nil {
		return nil, nil, fail(reasonMisconfigured, "%v", err)
	}
	opts := vault.TLSOptions{Fingerprint: hub.Fingerprint, Insecure: hub.InsecureSkipVerify}
	if hub.CASecretRef != nil {
		ca, serr := r.secretValue(ctx, ns, *hub.CASecretRef, "ca.crt")
		if serr != nil {
			return nil, nil, serr
		}
		opts.CAPEM = ca
	}
	c, err := r.clients.get(base, tok.T, opts)
	if err != nil {
		return nil, nil, fail(reasonMisconfigured, "%v", err)
	}
	return tok, c, nil
}

func hubFailure(err error) *syncError {
	switch {
	case vault.Unauthorized(err):
		return fail(reasonUnauthorized, "the hub rejected the token: it may be expired or revoked")
	case vault.NoAccess(err):
		return fail(reasonNoAccess, "environment not found, or not shared with this token (the hub does not say which)")
	default:
		return fail(reasonHubError, "%v", err)
	}
}

func (r *Reconciler) sync(ctx context.Context, cr *v1.EnvVaultSecret) (*syncResult, *syncError) {
	tok, hub, serr := r.hubClient(ctx, cr.Namespace, cr.Spec.TokenSecretRef, cr.Spec.Hub)
	if serr != nil {
		return nil, serr
	}

	noteExpiry(ctx, hub, &cr.Status.TokenExpiresAt)

	targetName := cr.Spec.Target.Name
	if targetName == "" {
		targetName = cr.Name
	}
	if cr.Spec.Target.Kind == kindConfigMap {
		return r.pullConfigMap(ctx, tok, hub, configMapPlan{
			namespace: cr.Namespace, project: cr.Spec.Project, environment: cr.Spec.Environment, target: targetName,
			group: cr.Spec.Group, restartOn: cr.Spec.RestartOn,
			owns:  func(c *corev1.ConfigMap) bool { return metav1.IsControlledBy(c, cr) },
			claim: func(c *corev1.ConfigMap) error { return controllerutil.SetControllerReference(cr, c, r.Scheme) },
		})
	}
	return r.pull(ctx, tok, hub, pullPlan{
		namespace: cr.Namespace, project: cr.Spec.Project, environment: cr.Spec.Environment, target: targetName,
		group:      cr.Spec.Group,
		secretType: corev1.SecretType(cr.Spec.Target.Type), restartOn: cr.Spec.RestartOn,
		owns:  func(s *corev1.Secret) bool { return metav1.IsControlledBy(s, cr) },
		claim: func(s *corev1.Secret) error { return controllerutil.SetControllerReference(cr, s, r.Scheme) },
	})
}

// selectGroup picks the keys one link carries. A named group with no keys is reported rather than
// written as an empty object: it is almost always a misspelt name, and an empty target would break the
// pods that read it. The default group may be empty (an environment with no keys yet).
func selectGroup(env vault.Env, group string) (map[string]string, *syncError) {
	g := vault.NormalizeGroup(group)
	if g != "" && !vault.ValidGroup(g) {
		return nil, fail(reasonMisconfigured, "%q is not a valid group name (1-40 characters: lower-case letters, digits or -)", group)
	}
	values := env.Group(g)
	if g != "" && len(values) == 0 {
		return nil, fail(reasonGroupEmpty, "group %q has no keys in this environment; check the name, or put keys in it in the dashboard", g)
	}
	return values, nil
}

// pullPlan is what one pull needs, whether it comes from an EnvVaultSecret or from a hub link: the
// two differ only in how a Secret is recognised as theirs.
type pullPlan struct {
	namespace, project, environment, target string
	group                                   string // key group to write; "" or "default" = keys that have none
	secretType                              corev1.SecretType
	restartOn                               []v1.WorkloadRef
	adopt                                   bool                       // the hub link says it may take over an existing Secret
	owns                                    func(*corev1.Secret) bool  // true when this Secret was written for this plan
	claim                                   func(*corev1.Secret) error // marks a Secret as written for this plan
}

func (r *Reconciler) pull(ctx context.Context, tok *vault.Token, hub *vault.Client, plan pullPlan) (*syncResult, *syncError) {
	targetName := plan.target
	secretType := plan.secretType
	if secretType == "" {
		secretType = corev1.SecretTypeOpaque
	}
	row, err := hub.Find(ctx, tok, plan.project, plan.environment)
	if err != nil {
		return nil, hubFailure(err)
	}
	version := fmt.Sprintf("%s#%d", row.UpdatedAt, row.KeyVersion)

	key := types.NamespacedName{Namespace: plan.namespace, Name: targetName}
	var existing corev1.Secret
	found := true
	// Cached read: only Secrets this operator wrote are in the cache. One that is missing from it
	// but exists (someone else's) is caught when the create fails with AlreadyExists.
	if err := r.Get(ctx, key, &existing); err != nil {
		if !apierrors.IsNotFound(err) {
			return nil, fail(reasonConflict, "cannot read Secret %q: %v", targetName, err)
		}
		found = false
	}
	taking := false
	if found && !plan.owns(&existing) {
		if !canTakeOver(&existing, plan.adopt) {
			return nil, fail(reasonConflict, "%s", conflictMessage("Secret", plan.namespace, targetName, &existing))
		}
		taking = true
	}

	res := &syncResult{version: version, keys: len(existing.Data), target: targetName}
	current := found && !taking &&
		existing.Annotations[annSource] == version &&
		existing.Annotations[annDigest] == digest(existing.Data) &&
		existing.Type == secretType
	if !current {
		if found && existing.Type != secretType {
			return nil, fail(reasonConflict, "Secret %q has type %q and a Secret's type cannot change; delete it so it can be recreated", targetName, existing.Type)
		}
		env, err := hub.OpenData(ctx, tok, plan.project, row)
		if err != nil {
			var de *vault.DecryptError
			if errors.As(err, &de) {
				return nil, fail(reasonDecrypt, "%v", err)
			}
			return nil, hubFailure(err)
		}
		values, serr := selectGroup(env, plan.group)
		if serr != nil {
			return nil, serr
		}
		if bad := invalidKeys(values); len(bad) > 0 {
			return nil, fail(reasonInvalidKeys, "these keys are not valid in a Kubernetes Secret: %v", bad)
		}
		data := toData(values)
		// build is the Secret to write on top of base (empty for a new one).
		build := func(base *corev1.Secret) (*corev1.Secret, error) {
			desired := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: targetName, Namespace: plan.namespace}}
			if base != nil {
				desired = base.DeepCopy()
			}
			if desired.Labels == nil {
				desired.Labels = map[string]string{}
			}
			if desired.Annotations == nil {
				desired.Annotations = map[string]string{}
			}
			desired.Labels[ManagedByLabel] = ManagedByValue
			desired.Annotations[annSource] = version
			desired.Annotations[annDigest] = digest(data)
			delete(desired.Annotations, AdoptAnnotation) // taken over: the invitation has been used
			desired.Type = secretType
			desired.Data = data
			return desired, plan.claim(desired)
		}
		var base *corev1.Secret
		if found {
			base = &existing
		}
		desired, err := build(base)
		if err != nil {
			return nil, fail(reasonConflict, "%v", err)
		}
		if found {
			err = r.Update(ctx, desired)
		} else {
			err = r.Create(ctx, desired)
		}
		if apierrors.IsAlreadyExists(err) {
			// Either the cache has not seen our own Secret yet, or it is someone else's (the cache holds
			// only what this operator wrote). Look at the real one.
			var live corev1.Secret
			if r.APIReader.Get(ctx, key, &live) != nil {
				return nil, fail(reasonConflict, "Secret %q already exists and cannot be read", targetName)
			}
			if plan.owns(&live) {
				res.keys = len(live.Data)
				return res, nil // ours; the next interval verifies it
			}
			if !canTakeOver(&live, plan.adopt) {
				return nil, fail(reasonConflict, "%s", conflictMessage("Secret", plan.namespace, targetName, &live))
			}
			if live.Type != secretType {
				return nil, fail(reasonConflict, "Secret %q has type %q and a Secret's type cannot change; delete it so it can be recreated", targetName, live.Type)
			}
			if desired, err = build(&live); err != nil {
				return nil, fail(reasonConflict, "%v", err)
			}
			err = r.Update(ctx, desired)
		}
		if err != nil {
			return nil, writeFailure("Secret", plan.namespace, targetName, err)
		}
		res.keys, res.wrote = len(data), true
	}

	if err := r.rollWorkloads(ctx, plan.namespace, plan.restartOn, version); err != nil {
		return nil, fail(reasonRollout, "%v", err)
	}
	return res, nil
}

// rollWorkloads stamps the version onto each listed workload's pod template, which makes
// Kubernetes replace the pods when it changes. It is idempotent and retried every interval.
func (r *Reconciler) rollWorkloads(ctx context.Context, namespace string, restartOn []v1.WorkloadRef, version string) error {
	for _, w := range restartOn {
		key := types.NamespacedName{Namespace: namespace, Name: w.Name}
		var obj client.Object
		var tmpl *corev1.PodTemplateSpec
		switch w.Kind {
		case "Deployment":
			d := &appsv1.Deployment{}
			obj, tmpl = d, &d.Spec.Template
		case "StatefulSet":
			s := &appsv1.StatefulSet{}
			obj, tmpl = s, &s.Spec.Template
		case "DaemonSet":
			s := &appsv1.DaemonSet{}
			obj, tmpl = s, &s.Spec.Template
		default:
			return fmt.Errorf("unsupported workload kind %q", w.Kind)
		}
		if err := r.APIReader.Get(ctx, key, obj); err != nil {
			if apierrors.IsNotFound(err) {
				continue // not deployed yet; it will pick the Secret up when it starts
			}
			return fmt.Errorf("cannot read %s %q: %v", w.Kind, w.Name, err)
		}
		if tmpl.Annotations[annRolled] == version {
			continue
		}
		orig := obj.DeepCopyObject().(client.Object)
		if tmpl.Annotations == nil {
			tmpl.Annotations = map[string]string{}
		}
		tmpl.Annotations[annRolled] = version
		if err := r.Patch(ctx, obj, client.MergeFrom(orig)); err != nil {
			if apierrors.IsForbidden(err) {
				return fmt.Errorf("not allowed to patch %s %q: %v", w.Kind, w.Name, err)
			}
			return fmt.Errorf("cannot roll %s %q: %v", w.Kind, w.Name, err)
		}
	}
	return nil
}

// writeFailure says why the cluster would not take the object, so one that is too large or a
// namespace that does not exist is not mistaken for a name clash.
func writeFailure(kind, namespace, name string, err error) *syncError {
	switch {
	case apierrors.IsNotFound(err):
		return fail(reasonMisconfigured, "namespace %q does not exist; create it, or link a namespace that does", namespace)
	case apierrors.IsInvalid(err), apierrors.IsRequestEntityTooLargeError(err):
		return fail(reasonRejected, "the cluster refused %s %q: %v", kind, name, err)
	case apierrors.IsForbidden(err):
		return fail(reasonRejected, "the operator is not allowed to write %s %q in %q: %v", kind, name, namespace, err)
	}
	return fail(reasonRejected, "cannot write %s %q: %v", kind, name, err)
}

// canTakeOver says whether a Secret or ConfigMap this plan did not write may be taken over: only a plain
// one, and only when its owner invited it (the annotation) or the hub link asked for it. One that
// another link, a custom resource or a push source owns is never taken.
func canTakeOver(o client.Object, hubSaysSo bool) bool {
	if o.GetLabels()[LinkLabel] != "" || metav1.GetControllerOf(o) != nil || o.GetLabels()[ManagedByLabel] == PushSourceValue {
		return false
	}
	return hubSaysSo || o.GetAnnotations()[AdoptAnnotation] == "true"
}

// conflictMessage tells a person what is in the way and how to resolve it.
func conflictMessage(kind, namespace, name string, o client.Object) string {
	if o.GetLabels()[LinkLabel] != "" || metav1.GetControllerOf(o) != nil || o.GetLabels()[ManagedByLabel] == PushSourceValue {
		return fmt.Sprintf("%s %q already belongs to something else; refusing to overwrite it. Pick another name, or remove what owns it", kind, name)
	}
	return fmt.Sprintf("%s %q already exists and was not written by this resource; refusing to overwrite it. To let it take over, run: kubectl -n %s annotate %s %s %s=true", kind, name, namespace, strings.ToLower(kind), name, AdoptAnnotation)
}
