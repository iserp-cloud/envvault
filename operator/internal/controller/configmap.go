package controller

import (
	"context"
	"errors"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/selection"
	"k8s.io/apimachinery/pkg/types"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

// ConfigMapSelector picks the only ConfigMaps the operator keeps in memory: the ones it wrote. The optional
// settings ConfigMap (namespaces, hub address) is read on demand and is never cached.
func ConfigMapSelector() labels.Selector {
	req, err := labels.NewRequirement(ManagedByLabel, selection.Equals, []string{ManagedByValue})
	if err != nil {
		panic(err)
	}
	return labels.NewSelector().Add(*req)
}

// configMapPlan is what one pull into a ConfigMap needs. It mirrors pullPlan; a ConfigMap has no type.
type configMapPlan struct {
	namespace, project, environment, target string
	group                                   string
	restartOn                               []v1.WorkloadRef
	adopt                                   bool
	owns                                    func(*corev1.ConfigMap) bool
	claim                                   func(*corev1.ConfigMap) error
}

// cmDigest hashes what a ConfigMap holds, so an edit made behind our back is noticed. Binary data counts:
// this operator never writes any, so any at all is a change to put back.
func cmDigest(c *corev1.ConfigMap) string {
	data := toData(c.Data)
	for k, v := range c.BinaryData {
		data["\x00binary:"+k] = v
	}
	return digest(data)
}

// pullConfigMap is pull for a ConfigMap: same ownership, take-over and change detection, plain text values.
func (r *Reconciler) pullConfigMap(ctx context.Context, tok *vault.Token, hub *vault.Client, plan configMapPlan) (*syncResult, *syncError) {
	row, err := hub.Find(ctx, tok, plan.project, plan.environment)
	if err != nil {
		return nil, hubFailure(err)
	}
	version := fmt.Sprintf("%s#%d", row.UpdatedAt, row.KeyVersion)

	key := types.NamespacedName{Namespace: plan.namespace, Name: plan.target}
	var existing corev1.ConfigMap
	found := true
	// Cached read: only ConfigMaps this operator wrote are in the cache. One that is missing from it but
	// exists (someone else's) is caught when the create fails with AlreadyExists.
	if err := r.Get(ctx, key, &existing); err != nil {
		if !apierrors.IsNotFound(err) {
			return nil, fail(reasonConflict, "cannot read ConfigMap %q: %v", plan.target, err)
		}
		found = false
	}
	taking := false
	if found && !plan.owns(&existing) {
		if !canTakeOver(&existing, plan.adopt) {
			return nil, fail(reasonConflict, "%s", conflictMessage(kindConfigMap, plan.namespace, plan.target, &existing))
		}
		taking = true
	}

	res := &syncResult{version: version, keys: len(existing.Data), target: plan.target}
	current := found && !taking &&
		existing.Annotations[annSource] == version &&
		existing.Annotations[annDigest] == cmDigest(&existing)
	if !current {
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
			return nil, fail(reasonInvalidKeys, "these keys are not valid in a Kubernetes ConfigMap: %v", bad)
		}
		build := func(base *corev1.ConfigMap) (*corev1.ConfigMap, error) {
			desired := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: plan.target, Namespace: plan.namespace}}
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
			desired.Data, desired.BinaryData = values, nil
			desired.Annotations[annSource] = version
			desired.Annotations[annDigest] = cmDigest(desired)
			delete(desired.Annotations, AdoptAnnotation) // taken over: the invitation has been used
			return desired, plan.claim(desired)
		}
		var base *corev1.ConfigMap
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
			// Either the cache has not seen our own ConfigMap yet, or it is someone else's. Look at the real one.
			var live corev1.ConfigMap
			if r.APIReader.Get(ctx, key, &live) != nil {
				return nil, fail(reasonConflict, "ConfigMap %q already exists and cannot be read", plan.target)
			}
			if plan.owns(&live) {
				res.keys = len(live.Data)
				return res, nil // ours; the next interval verifies it
			}
			if !canTakeOver(&live, plan.adopt) {
				return nil, fail(reasonConflict, "%s", conflictMessage(kindConfigMap, plan.namespace, plan.target, &live))
			}
			if desired, err = build(&live); err != nil {
				return nil, fail(reasonConflict, "%v", err)
			}
			err = r.Update(ctx, desired)
		}
		if err != nil {
			return nil, writeFailure(kindConfigMap, plan.namespace, plan.target, err)
		}
		res.keys, res.wrote = len(values), true
	}

	if err := r.rollWorkloads(ctx, plan.namespace, plan.restartOn, version); err != nil {
		return nil, fail(reasonRollout, "%v", err)
	}
	return res, nil
}
