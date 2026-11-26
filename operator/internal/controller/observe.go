package controller

import (
	"context"
	"fmt"
	"time"

	"github.com/iserp-cloud/envvault/operator/internal/vault"
	"github.com/prometheus/client_golang/prometheus"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
	reconcileTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "envvault_reconcile_total",
		Help: "Checks of an EnvVaultSecret or EnvVaultPush, by outcome: ok, or the reason it failed.",
	}, []string{"controller", "result"})
	updatesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "envvault_updates_total",
		Help: "Times a Secret was written from the hub (secret) or the environment was written from a Secret (push).",
	}, []string{"controller"})
)

func init() { metrics.Registry.MustRegister(reconcileTotal, updatesTotal) }

// observe counts one check and raises an event when something changed that a person should see:
// a new failure (or a different one), an update, or recovery. A resource that keeps failing for
// the same reason raises one event, not one per retry. Messages are the ones the status already
// carries, so values never reach an event.
func observe(rec record.EventRecorder, obj runtime.Object, controller string, prev *metav1.Condition, serr *syncError, wrote bool, updated string) {
	if serr != nil {
		reconcileTotal.WithLabelValues(controller, serr.reason).Inc()
		if rec != nil && (prev == nil || prev.Status != metav1.ConditionFalse || prev.Reason != serr.reason) {
			rec.Event(obj, "Warning", serr.reason, serr.err.Error())
		}
		return
	}
	reconcileTotal.WithLabelValues(controller, "ok").Inc()
	if wrote {
		updatesTotal.WithLabelValues(controller).Inc()
	}
	if rec == nil {
		return
	}
	switch {
	case wrote:
		rec.Event(obj, "Normal", "Updated", updated)
	case prev != nil && prev.Status == metav1.ConditionFalse:
		rec.Event(obj, "Normal", "Recovered", "Working again")
	}
}

// noteExpiry records when the token stops working. The client asks the hub once, not every check.
func noteExpiry(ctx context.Context, hub *vault.Client, at **metav1.Time) {
	if t, ok := hub.Expiry(ctx); ok {
		mt := metav1.NewTime(t)
		*at = &mt
	}
}

var expiryThresholds = []int{14, 7, 3, 1}

// warnExpiry raises one Warning as the token crosses 14, 7, 3 and 1 days left, and starts over
// once the token is replaced by one with more time.
func warnExpiry(rec record.EventRecorder, obj runtime.Object, at *metav1.Time, warned *int, now time.Time) {
	if at == nil {
		return
	}
	days := int((at.Sub(now) + 24*time.Hour - 1) / (24 * time.Hour)) // whole days left, rounded up
	step := 0
	for _, t := range expiryThresholds {
		if days <= t {
			step = t
		}
	}
	if step == 0 {
		*warned = 0
		return
	}
	if *warned != 0 && step >= *warned {
		return
	}
	*warned = step
	if rec != nil {
		rec.Event(obj, "Warning", "TokenExpiring", fmt.Sprintf("the service token expires on %s (%d days left); create a new one and update the token Secret", at.Format("2006-01-02"), max(days, 0)))
	}
}
