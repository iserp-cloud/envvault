package controller

import (
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/record"
)

func TestEventsAreRaisedOnChangeNotOnEveryRetry(t *testing.T) {
	rec := record.NewFakeRecorder(10)
	obj := &corev1.Secret{}
	notReady := func(reason string) *metav1.Condition {
		return &metav1.Condition{Type: condReady, Status: metav1.ConditionFalse, Reason: reason}
	}
	down := fail(reasonHubError, "hub is down")

	observe(rec, obj, "secret", nil, down, false, "")                                                     // first failure: event
	observe(rec, obj, "secret", notReady(reasonHubError), down, false, "")                                // same failure again: none
	observe(rec, obj, "secret", notReady(reasonHubError), fail(reasonUnauthorized, "expired"), false, "") // different: event
	observe(rec, obj, "secret", notReady(reasonUnauthorized), nil, false, "")                             // recovered: event
	observe(rec, obj, "secret", &metav1.Condition{Status: metav1.ConditionTrue}, nil, false, "")          // steady: none
	observe(rec, obj, "secret", &metav1.Condition{Status: metav1.ConditionTrue}, nil, true, "Secret updated from the hub")

	close(rec.Events)
	var got []string
	for e := range rec.Events {
		got = append(got, e)
	}
	want := []string{"Warning " + reasonHubError, "Warning " + reasonUnauthorized, "Normal Recovered", "Normal Updated"}
	if len(got) != len(want) {
		t.Fatalf("events = %v, want %d", got, len(want))
	}
	for i, w := range want {
		if !strings.HasPrefix(got[i], w) {
			t.Errorf("event %d = %q, want prefix %q", i, got[i], w)
		}
	}
}

func TestExpiryWarnsOncePerThresholdAndResetsOnRenewal(t *testing.T) {
	rec := record.NewFakeRecorder(10)
	obj := &corev1.Secret{}
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	at := func(days float64) *metav1.Time {
		m := metav1.NewTime(now.Add(time.Duration(days * 24 * float64(time.Hour))))
		return &m
	}
	warned := 0
	for _, d := range []float64{40, 20, 13.5, 13, 9, 6.5, 6, 2.5, 0.5} {
		warnExpiry(rec, obj, at(d), &warned, now)
	}
	if len(rec.Events) != 4 || warned != 1 { // 14, 7, 3 and 1 days
		t.Fatalf("events=%d warned=%d, want 4 and 1", len(rec.Events), warned)
	}
	warnExpiry(rec, obj, at(90), &warned, now) // a new token
	if warned != 0 {
		t.Fatalf("warned=%d after renewal, want 0", warned)
	}
	warnExpiry(rec, obj, nil, &warned, now) // hub that does not say: nothing, no panic
}
