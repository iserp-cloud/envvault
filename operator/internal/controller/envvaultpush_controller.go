package controller

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"
	"unicode/utf8"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/selection"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

// PushSourceValue marks a source Secret the operator watches: it is labelled so that it is the
// only kind of foreign Secret held in the cache, and a change to it is pushed at once.
const PushSourceValue = "envvault-push-source"

// SecretSelector picks the only Secrets the operator keeps in memory: the ones it wrote and the
// push sources it labelled. Token and CA Secrets are read on demand.
func SecretSelector() labels.Selector {
	req, err := labels.NewRequirement(ManagedByLabel, selection.In, []string{ManagedByValue, PushSourceValue})
	if err != nil {
		panic(err)
	}
	return labels.NewSelector().Add(*req)
}

const (
	reasonPushed       = "Pushed"
	reasonReadOnly     = "ReadOnly"
	reasonHubConflict  = "HubConflict"
	reasonRekeying     = "RekeyPending"
	reasonInvalidValue = "InvalidValues"
	reasonSourceEmpty  = "SourceEmpty"
)

// PushReconciler writes a Secret's keys into a hub environment. It shares the hub-client code
// (token, trust, connection reuse) with the pull reconciler.
type PushReconciler struct {
	R *Reconciler
}

// +kubebuilder:rbac:groups=envvault.io,resources=envvaultpushes,verbs=get;list;watch
// +kubebuilder:rbac:groups=envvault.io,resources=envvaultpushes/status,verbs=get;update;patch

func (p *PushReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		Named("envvaultpush").
		For(&v1.EnvVaultPush{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(p.pushesFor)).
		WithOptions(controller.Options{MaxConcurrentReconciles: max(p.R.Concurrency, 1)}).
		Complete(p)
}

// pushesFor maps a changed Secret to the pushes that read it, so an edit is pushed at once
// instead of at the next interval.
func (p *PushReconciler) pushesFor(ctx context.Context, obj client.Object) []ctrl.Request {
	if obj.GetLabels()[ManagedByLabel] != PushSourceValue {
		return nil
	}
	var list v1.EnvVaultPushList
	if err := p.R.List(ctx, &list, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}
	var out []ctrl.Request
	for _, cr := range list.Items {
		if cr.Spec.SourceSecretName == obj.GetName() {
			out = append(out, ctrl.Request{NamespacedName: types.NamespacedName{Namespace: cr.Namespace, Name: cr.Name}})
		}
	}
	return out
}

func (p *PushReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	var cr v1.EnvVaultPush
	if err := p.R.Get(ctx, req.NamespacedName, &cr); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !cr.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}

	orig := cr.DeepCopy()
	res, serr := p.push(ctx, &cr)
	warnExpiry(p.R.Recorder, &cr, cr.Status.TokenExpiresAt, &cr.Status.ExpiryWarnedDays, time.Now())
	observe(p.R.Recorder, &cr, "push", meta.FindStatusCondition(orig.Status.Conditions, condReady), serr, serr == nil && res.wrote, "Environment updated from the Secret")
	cr.Status.ObservedGeneration = cr.Generation
	if serr != nil {
		cr.Status.ConsecutiveFailures++
		log.Info("push failed", "reason", serr.reason, "error", serr.err.Error())
		meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
			Type: condReady, Status: metav1.ConditionFalse, Reason: serr.reason, Message: serr.err.Error(), ObservedGeneration: cr.Generation,
		})
	} else {
		cr.Status.ConsecutiveFailures = 0
		cr.Status.ObservedVersion = res.version
		cr.Status.SourceDigest = res.digest
		cr.Status.KeyCount = res.keys
		if res.wrote {
			now := metav1.Now()
			cr.Status.LastPushTime = &now
			log.Info("environment updated", "project", cr.Spec.Project, "environment", cr.Spec.Environment, "keys", res.keys)
		}
		meta.SetStatusCondition(&cr.Status.Conditions, metav1.Condition{
			Type: condReady, Status: metav1.ConditionTrue, Reason: reasonPushed, Message: "Environment holds the Secret's values", ObservedGeneration: cr.Generation,
		})
	}
	if !reflect.DeepEqual(orig.Status, cr.Status) {
		if err := p.R.Status().Patch(ctx, &cr, client.MergeFrom(orig)); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	interval := refreshOf(&v1.EnvVaultSecret{Spec: v1.EnvVaultSecretSpec{RefreshInterval: cr.Spec.RefreshInterval}})
	return ctrl.Result{RequeueAfter: jitter(backoff(interval, cr.Status.ConsecutiveFailures))}, nil
}

type pushResult struct {
	version string
	digest  string
	keys    int
	wrote   bool
}

func (p *PushReconciler) push(ctx context.Context, cr *v1.EnvVaultPush) (*pushResult, *syncError) {
	tok, hub, serr := p.R.hubClient(ctx, cr.Namespace, cr.Spec.TokenSecretRef, cr.Spec.Hub)
	if serr != nil {
		return nil, serr
	}

	noteExpiry(ctx, hub, &cr.Status.TokenExpiresAt)

	return p.pushPlanned(ctx, tok, hub, pushPlan{
		namespace: cr.Namespace, project: cr.Spec.Project, environment: cr.Spec.Environment, source: cr.Spec.SourceSecretName,
		note:     fmt.Sprintf("Pushed by envvault-operator (%s/%s)", cr.Namespace, cr.Name),
		observed: cr.Status.ObservedVersion, digest: cr.Status.SourceDigest,
	})
}

// pushPlan is what one push needs, whether it comes from an EnvVaultPush or from a hub link.
type pushPlan struct {
	namespace, project, environment, source string
	note                                    string // the label on the saved version
	observed, digest                        string // what the last successful push saw, to skip unchanged work
}

func (p *PushReconciler) pushPlanned(ctx context.Context, tok *vault.Token, hub *vault.Client, plan pushPlan) (*pushResult, *syncError) {
	// Not cached: the source is somebody else's Secret, and the operator holds only its own in memory.
	var src corev1.Secret
	if err := p.R.APIReader.Get(ctx, types.NamespacedName{Namespace: plan.namespace, Name: plan.source}, &src); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, fail(reasonMisconfigured, "source secret %q not found in this namespace", plan.source)
		}
		return nil, fail(reasonMisconfigured, "cannot read source secret %q: %v", plan.source, err)
	}
	if src.Labels[ManagedByLabel] == ManagedByValue {
		// An EnvVaultSecret writes this Secret from the hub; pushing it back would make the two take turns overwriting each other.
		return nil, fail(reasonMisconfigured, "source secret %q is written by an EnvVaultSecret from the hub; pushing it back would loop. Push a Secret of your own", plan.source)
	}
	if src.Labels[ManagedByLabel] != PushSourceValue {
		// Label it so later edits are noticed immediately. Its data is not touched.
		orig := src.DeepCopy()
		if src.Labels == nil {
			src.Labels = map[string]string{}
		}
		src.Labels[ManagedByLabel] = PushSourceValue
		if err := p.R.Patch(ctx, &src, client.MergeFrom(orig)); err != nil {
			logf.FromContext(ctx).Info("could not label the source secret; it will be checked every interval instead", "error", err.Error())
		}
	}
	if len(src.Data) == 0 {
		return nil, fail(reasonSourceEmpty, "source secret %q has no keys; nothing to push", plan.source)
	}
	want := make(map[string]string, len(src.Data))
	var bad []string
	for k, v := range src.Data {
		if !utf8.Valid(v) {
			bad = append(bad, k)
		}
		want[k] = string(v)
	}
	if len(bad) > 0 {
		return nil, fail(reasonInvalidValue, "these keys hold binary data, which an environment cannot store: %v", sortedStrings(bad))
	}
	sum := digest(src.Data)
	res := &pushResult{digest: sum, keys: len(want)}

	// A save that loses a race with another writer is repeated on fresh data straight away, so
	// two things editing at once settle in moments instead of one interval.
	for attempt := 1; ; attempt++ {
		serr := p.pushOnce(ctx, plan, tok, hub, want, res)
		if serr != nil && serr.reason == reasonHubConflict && attempt < pushAttempts {
			continue
		}
		if serr != nil {
			return nil, serr
		}
		return res, nil
	}
}

// pushAttempts is how many times one check tries a save that keeps losing to other writers.
const pushAttempts = 3

func (p *PushReconciler) pushOnce(ctx context.Context, plan pushPlan, tok *vault.Token, hub *vault.Client, want map[string]string, res *pushResult) *syncError {
	row, err := hub.Find(ctx, tok, plan.project, plan.environment)
	if err != nil {
		return hubFailure(err)
	}
	if row.Level != "write" {
		return fail(reasonReadOnly, "the token can only read this environment; give it write access in the dashboard")
	}
	if row.RotatePending {
		return fail(reasonRekeying, "the environment is waiting to be re-keyed; push again after it has been")
	}
	version := fmt.Sprintf("%s#%d", row.UpdatedAt, row.KeyVersion)
	res.version = version
	if plan.observed == version && plan.digest == res.digest {
		return nil // nothing changed on either side since the last check
	}

	current, err := hub.Open(ctx, tok, plan.project, row)
	if err != nil {
		var de *vault.DecryptError
		if errors.As(err, &de) {
			return fail(reasonDecrypt, "%v", err)
		}
		return hubFailure(err)
	}
	merged := make(map[string]string, len(current)+len(want))
	for k, v := range current {
		merged[k] = v
	}
	differs := false
	for k, v := range want {
		if old, ok := current[k]; !ok || old != v {
			differs = true
		}
		merged[k] = v
	}
	if !differs {
		return nil
	}

	box, err := vault.SealFor(tok, plan.project, row, merged)
	if err != nil {
		return fail(reasonDecrypt, "%v", err)
	}
	updatedAt, err := hub.SaveEnv(ctx, tok, plan.project, row.Name, box, row.UpdatedAt, plan.note)
	if err != nil {
		if vault.Conflict(err) {
			return fail(reasonHubConflict, "the environment was changed on the hub while pushing; will retry")
		}
		return hubFailure(err)
	}
	res.version, res.wrote = fmt.Sprintf("%s#%d", updatedAt, row.KeyVersion), true
	return nil
}
