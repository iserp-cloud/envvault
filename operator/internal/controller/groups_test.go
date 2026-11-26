package controller

import (
	"context"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

// The vectors' environment, sorted into groups: DATABASE_URL in db; API_KEY and EMPTY in api; the rest in no group.
var testGroups = map[string]string{"DATABASE_URL": "db", "API_KEY": "api", "EMPTY": "api"}

// setEnv replaces what the hub holds (a new version, as if saved in the dashboard).
func (e *linkEnv) setEnv(t *testing.T, env vault.Env) {
	t.Helper()
	e.h.mu.Lock()
	defer e.h.mu.Unlock()
	x := e.v.Environment
	box, err := vault.SealEnvData(env, e.h.dek, vault.EnvAAD(x.TenantID, x.Project, x.Name))
	if err != nil {
		t.Fatal(err)
	}
	e.h.payload = box
	e.h.version++
}

func (e *linkEnv) grouped(t *testing.T) {
	t.Helper()
	e.setEnv(t, vault.Env{Vars: e.v.Environment.Expected, Groups: testGroups})
}

func (e *linkEnv) groupLink(id, name, dir, group, kind string) vault.AgentLink {
	l := e.link(id, "prod", name, dir)
	l.Group, l.Kind = group, kind
	return l
}

func (e *linkEnv) configMap(ns, name string) (*corev1.ConfigMap, bool) {
	var c corev1.ConfigMap
	if err := e.c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: name}, &c); err != nil {
		return nil, false
	}
	return &c, true
}

func keysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return sortedStrings(out)
}

func TestEachLinkWritesOnlyItsGroup(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	e.h.links = []vault.AgentLink{
		e.groupLink("def", "app-default", "pull", "", ""), // an older hub: no group, no kind
		e.groupLink("def2", "app-default2", "pull", "default", "Secret"),
		e.groupLink("db", "app-db", "pull", "db", "Secret"),
		e.groupLink("api", "app-api", "pull", "api", "Secret"),
	}
	e.poll(t)
	for _, id := range []string{"def", "def2", "db", "api"} {
		e.reconcile(t, id)
	}
	want := map[string][]string{
		"app-default":  {"MULTILINE", "UNICODE"},
		"app-default2": {"MULTILINE", "UNICODE"},
		"app-db":       {"DATABASE_URL"},
		"app-api":      {"API_KEY", "EMPTY"},
	}
	for name, keys := range want {
		s, ok := e.secret("prod", name)
		if !ok {
			t.Fatalf("%s was not created", name)
		}
		if got := keysOf(s.Data); !reflect.DeepEqual(got, keys) {
			t.Errorf("%s holds %v, want %v", name, got, keys)
		}
	}
	e.poll(t)
	if r, _ := e.lastReport("api"); r.Status != reasonSynced || r.KeyCount != 2 {
		t.Fatalf("report = %+v", r)
	}
}

func TestAnEnvironmentWithoutGroupsGivesEveryKeyToTheDefaultGroup(t *testing.T) {
	e := setupLinks(t, "prod") // the vectors' plain environment
	e.h.links = []vault.AgentLink{e.groupLink("l", "app", "pull", "default", "Secret")}
	e.poll(t)
	e.reconcile(t, "l")
	s, _ := e.secret("prod", "app")
	if got := len(s.Data); got != len(e.v.Environment.Expected) {
		t.Fatalf("the default group holds %d keys, the environment has %d", got, len(e.v.Environment.Expected))
	}
}

func TestALinkForAGroupThatHasNoKeysSaysSoAndWritesNothing(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	e.h.links = []vault.AgentLink{e.groupLink("typo", "app-typo", "pull", "dbb", "Secret"), e.groupLink("cm", "cm-typo", "pull", "nope", "ConfigMap")}
	e.poll(t)
	e.reconcile(t, "typo")
	e.reconcile(t, "cm")
	if _, ok := e.secret("prod", "app-typo"); ok {
		t.Fatal("wrote a Secret for a group with no keys")
	}
	if _, ok := e.configMap("prod", "cm-typo"); ok {
		t.Fatal("wrote a ConfigMap for a group with no keys")
	}
	e.poll(t)
	for _, id := range []string{"typo", "cm"} {
		r, _ := e.lastReport(id)
		if r.Status != reasonGroupEmpty || !strings.Contains(r.Message, "has no keys") {
			t.Fatalf("%s report = %+v", id, r)
		}
	}
	// The default group may be empty: an environment can be all groups.
	e.setEnv(t, vault.Env{Vars: map[string]string{"A": "1"}, Groups: map[string]string{"A": "db"}})
	e.h.links = []vault.AgentLink{e.groupLink("d", "app-d", "pull", "", "Secret")}
	e.poll(t)
	e.reconcile(t, "d")
	if s, ok := e.secret("prod", "app-d"); !ok || len(s.Data) != 0 {
		t.Fatalf("the default group should be written, empty: %v %v", ok, s)
	}
}

func TestMovingAKeyBetweenGroupsMovesItBetweenTargets(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	e.h.links = []vault.AgentLink{e.groupLink("db", "app-db", "pull", "db", "Secret"), e.groupLink("def", "app", "pull", "", "Secret")}
	e.poll(t)
	e.reconcile(t, "db")
	e.reconcile(t, "def")
	// DATABASE_URL moves from db to no group.
	moved := map[string]string{"API_KEY": "api", "EMPTY": "api", "UNICODE": "db"}
	e.setEnv(t, vault.Env{Vars: e.v.Environment.Expected, Groups: moved})
	e.reconcile(t, "db")
	e.reconcile(t, "def")
	db, _ := e.secret("prod", "app-db")
	def, _ := e.secret("prod", "app")
	if got := keysOf(db.Data); !reflect.DeepEqual(got, []string{"UNICODE"}) {
		t.Errorf("db now holds %v", got)
	}
	if got := keysOf(def.Data); !reflect.DeepEqual(got, []string{"DATABASE_URL", "MULTILINE"}) {
		t.Errorf("default now holds %v", got)
	}
}

func TestLinkPullsIntoAConfigMap(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	e.h.links = []vault.AgentLink{e.groupLink("cm", "app-config", "pull", "api", "ConfigMap")}
	e.poll(t)
	e.reconcile(t, "cm")
	if _, ok := e.secret("prod", "app-config"); ok {
		t.Fatal("a ConfigMap link wrote a Secret")
	}
	c, ok := e.configMap("prod", "app-config")
	if !ok {
		t.Fatal("the ConfigMap was not created")
	}
	if got := keysOf(c.Data); !reflect.DeepEqual(got, []string{"API_KEY", "EMPTY"}) || c.Data["API_KEY"] != e.v.Environment.Expected["API_KEY"] {
		t.Fatalf("data = %v", got)
	}
	if c.Labels[LinkLabel] != "cm" || c.Labels[ManagedByLabel] != ManagedByValue || len(c.OwnerReferences) != 0 {
		t.Fatalf("labels=%v owners=%v", c.Labels, c.OwnerReferences)
	}
	e.poll(t)
	if r, _ := e.lastReport("cm"); r.Status != reasonSynced || r.KeyCount != 2 {
		t.Fatalf("report = %+v", r)
	}
}

func TestAConfigMapIsOnlyRewrittenWhenSomethingChanged(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	e.h.links = []vault.AgentLink{e.groupLink("cm", "app-config", "pull", "api", "ConfigMap")}
	e.poll(t)
	e.reconcile(t, "cm")
	before := e.h.getEnvs
	e.reconcile(t, "cm")
	if e.h.getEnvs != before {
		t.Fatalf("an unchanged environment was downloaded again (%d -> %d)", before, e.h.getEnvs)
	}
	// A hand edit, and binary data added behind our back, are put back.
	c, _ := e.configMap("prod", "app-config")
	c.Data["API_KEY"] = "tampered"
	c.BinaryData = map[string][]byte{"blob": []byte("x")}
	if err := e.c.Update(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	e.reconcile(t, "cm")
	c, _ = e.configMap("prod", "app-config")
	if c.Data["API_KEY"] != e.v.Environment.Expected["API_KEY"] || len(c.BinaryData) != 0 {
		t.Fatalf("hand edit survived: %v %v", c.Data["API_KEY"] == "tampered", c.BinaryData)
	}
}

func TestASecretAndAConfigMapMayShareANameAndAreLinkedIndependently(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	e.h.links = []vault.AgentLink{e.groupLink("s", "app", "pull", "db", "Secret"), e.groupLink("c", "app", "pull", "api", "ConfigMap")}
	e.poll(t)
	e.reconcile(t, "s")
	e.reconcile(t, "c")
	s, sok := e.secret("prod", "app")
	c, cok := e.configMap("prod", "app")
	if !sok || !cok || keysOf(s.Data)[0] != "DATABASE_URL" || keysOf(c.Data)[0] != "API_KEY" {
		t.Fatalf("secret=%v configmap=%v", sok, cok)
	}
	if e.l.byTarget["Secret/prod/app"] != "s" || e.l.byTarget["ConfigMap/prod/app"] != "c" {
		t.Fatalf("byTarget = %v", e.l.byTarget)
	}
}

func TestAConfigMapLinkNeverOverwritesOneItDidNotWriteUnlessInvited(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	mine := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "app-config", Namespace: "prod"}, Data: map[string]string{"KEEP": "me"}}
	if err := e.c.Create(context.Background(), mine); err != nil {
		t.Fatal(err)
	}
	l := e.groupLink("cm", "app-config", "pull", "api", "ConfigMap")
	e.h.links = []vault.AgentLink{l}
	e.poll(t)
	e.reconcile(t, "cm")
	c, _ := e.configMap("prod", "app-config")
	if c.Data["KEEP"] != "me" || len(c.Data) != 1 {
		t.Fatalf("overwrote a ConfigMap it did not write: %v", c.Data)
	}
	e.poll(t)
	r, _ := e.lastReport("cm")
	if r.Status != reasonConflict || !strings.Contains(r.Message, "kubectl -n prod annotate configmap app-config "+AdoptAnnotation+"=true") {
		t.Fatalf("report = %+v", r)
	}
	// The hub invites the take-over: the values are replaced and the object is the link's from then on.
	l.Adopt = true
	e.h.links = []vault.AgentLink{l}
	e.poll(t)
	e.reconcile(t, "cm")
	c, _ = e.configMap("prod", "app-config")
	if _, kept := c.Data["KEEP"]; kept || c.Labels[LinkLabel] != "cm" || c.Annotations[AdoptAnnotation] != "" {
		t.Fatalf("take-over did not complete: %v %v", c.Data, c.Labels)
	}
	// Something else's ConfigMap (another link's) is never taken, invited or not.
	other := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "theirs", Namespace: "prod", Labels: map[string]string{LinkLabel: "someone"}}}
	_ = e.c.Create(context.Background(), other)
	l2 := e.groupLink("cm2", "theirs", "pull", "api", "ConfigMap")
	l2.Adopt = true
	e.h.links = []vault.AgentLink{l, l2, e.groupLink("someone", "x", "pull", "", "Secret")}
	e.poll(t)
	e.reconcile(t, "cm2")
	got, _ := e.configMap("prod", "theirs")
	if len(got.Data) != 0 {
		t.Fatal("took a ConfigMap that another link owns")
	}
}

func TestRemovingAConfigMapLinkLeavesTheConfigMapButStopsManagingIt(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	e.h.links = []vault.AgentLink{e.groupLink("cm", "app-config", "pull", "api", "ConfigMap")}
	e.poll(t)
	e.reconcile(t, "cm")
	e.h.links = nil
	e.poll(t)
	c, ok := e.configMap("prod", "app-config")
	if !ok || len(c.Data) != 2 {
		t.Fatal("the ConfigMap should stay, with its values")
	}
	if _, owned := c.Labels[LinkLabel]; owned {
		t.Fatalf("still labelled as managed: %v", c.Labels)
	}
}

func TestPushPutsTheKeysInTheLinksGroupAndLeavesOthersAlone(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.level = "write"
	e.grouped(t)
	src := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "src", Namespace: "prod"}, Data: map[string][]byte{"NEW": []byte("n"), "API_KEY": []byte("rotated")}}
	if err := e.c.Create(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	e.h.links = []vault.AgentLink{e.groupLink("p", "src", "push", "svc", "Secret")}
	e.poll(t)
	e.reconcile(t, "p")

	got := e.h.storedEnv(t)
	if got.Vars["NEW"] != "n" || got.Vars["API_KEY"] != "rotated" {
		t.Fatalf("keys not pushed: %v", got.Vars)
	}
	if got.Groups["NEW"] != "svc" || got.Groups["API_KEY"] != "svc" {
		t.Fatalf("pushed keys should be in the link's group: %v", got.Groups)
	}
	// Keys the Secret lacks keep their value and their group.
	if got.Groups["DATABASE_URL"] != "db" || got.Groups["EMPTY"] != "api" || got.Vars["UNICODE"] == "" {
		t.Fatalf("other keys were disturbed: %v", got.Groups)
	}
}

func TestPushWithNoGroupTakesKeysOutOfTheirGroupAndStaysPlainWhenNoneIsLeft(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.level = "write"
	e.setEnv(t, vault.Env{Vars: map[string]string{"A": "1", "B": "2"}, Groups: map[string]string{"A": "db"}})
	src := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "src", Namespace: "prod"}, Data: map[string][]byte{"A": []byte("1")}} // same value, other group
	if err := e.c.Create(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	e.h.links = []vault.AgentLink{e.groupLink("p", "src", "push", "", "Secret")}
	e.poll(t)
	e.reconcile(t, "p")
	got := e.h.storedEnv(t)
	if len(got.Groups) != 0 {
		t.Fatalf("groups = %v: a group change alone must be saved", got.Groups)
	}
	// With no group left the payload is the plain shape again, so older clients can read it.
	if _, err := vault.OpenEnv(e.h.payload, e.h.dek, vault.EnvAAD(e.v.Environment.TenantID, e.v.Environment.Project, e.v.Environment.Name)); err != nil {
		t.Fatalf("a plain environment should be saved plain: %v", err)
	}
}

func TestAReaderThatCannotHandleGroupsRefusesAGroupedEnvironment(t *testing.T) {
	e := setupLinks(t, "prod")
	e.grouped(t)
	if _, err := vault.OpenEnv(e.h.payload, e.h.dek, vault.EnvAAD(e.v.Environment.TenantID, e.v.Environment.Project, e.v.Environment.Name)); err == nil {
		t.Fatal("the plain reader accepted an environment with groups")
	}
}

func groupedPayload(spec *v1.EnvVaultSecretSpec, v *vectors) {
	v.Environment.Payload = v.Grouped.Payload
	_ = spec
}

func TestEnvVaultSecretWritesOnlyItsGroup(t *testing.T) {
	e := setupWith(t, func(spec *v1.EnvVaultSecretSpec, v *vectors) { groupedPayload(spec, v); spec.Group = "api" })
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Status != metav1.ConditionTrue {
		t.Fatalf("not ready: %+v", c)
	}
	if got := keysOf(e.secret(t).Data); !reflect.DeepEqual(got, []string{"API_KEY", "EMPTY"}) {
		t.Fatalf("the Secret holds %v", got)
	}
}

func TestEnvVaultSecretWithoutAGroupGetsTheDefaultGroup(t *testing.T) {
	e := setupWith(t, func(spec *v1.EnvVaultSecretSpec, v *vectors) { groupedPayload(spec, v) })
	e.reconcile(t)
	if got := keysOf(e.secret(t).Data); !reflect.DeepEqual(got, []string{"MULTILINE", "UNICODE"}) {
		t.Fatalf("the Secret holds %v", got)
	}
}

func TestEnvVaultSecretCanWriteAConfigMap(t *testing.T) {
	e := setupWith(t, func(spec *v1.EnvVaultSecretSpec, v *vectors) {
		groupedPayload(spec, v)
		spec.Group, spec.Target.Kind = "db", "ConfigMap"
	})
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Status != metav1.ConditionTrue {
		t.Fatalf("not ready: %+v", c)
	}
	var cm corev1.ConfigMap
	if err := e.c.Get(context.Background(), e.key, &cm); err != nil {
		t.Fatal(err)
	}
	if len(cm.Data) != 1 || cm.Data["DATABASE_URL"] != e.v.Environment.Expected["DATABASE_URL"] || len(cm.OwnerReferences) != 1 {
		t.Fatalf("data=%v owners=%v", keysOf(cm.Data), cm.OwnerReferences)
	}
	var s corev1.Secret
	if err := e.c.Get(context.Background(), e.key, &s); err == nil {
		t.Fatal("a ConfigMap target also created a Secret")
	}
}

func TestEnvVaultSecretWithABadGroupNameIsMisconfigured(t *testing.T) {
	e := setupWith(t, func(spec *v1.EnvVaultSecretSpec, v *vectors) { spec.Group = "Not Valid" })
	cr := e.reconcile(t)
	if c := e.ready(cr); c == nil || c.Reason != reasonMisconfigured {
		t.Fatalf("condition = %+v", c)
	}
}

func TestPushKeepsTheDashboardsRegistryOfGroupNames(t *testing.T) {
	e := setupLinks(t, "prod")
	e.h.level = "write"
	e.setEnv(t, vault.Env{Vars: map[string]string{"A": "1"}, Groups: map[string]string{}, Labels: []string{"db", "queue"}})
	src := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "src", Namespace: "prod"}, Data: map[string][]byte{"B": []byte("2")}}
	if err := e.c.Create(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	e.h.links = []vault.AgentLink{e.groupLink("p", "src", "push", "", "Secret")}
	e.poll(t)
	e.reconcile(t, "p")
	got := e.h.storedEnv(t)
	if got.Vars["B"] != "2" {
		t.Fatalf("not pushed: %v", got.Vars)
	}
	if !reflect.DeepEqual(got.Labels, []string{"db", "queue"}) {
		t.Fatalf("the push erased the registry: %v", got.Labels)
	}
}

// Group names and the dashboard's list of them are how the vault is organised, not part of what a cluster gets:
// a Secret or ConfigMap holds the group's keys and values and nothing that says which group, or which other
// groups, there are.
func TestNothingAboutGroupsReachesTheCluster(t *testing.T) {
	e := setupLinks(t, "prod")
	registry := []string{"api", "db", "queue", "unused-name"}
	e.setEnv(t, vault.Env{Vars: e.v.Environment.Expected, Groups: testGroups, Labels: registry})
	e.h.links = []vault.AgentLink{
		e.groupLink("def", "app-default", "pull", "", "Secret"),
		e.groupLink("db", "app-db", "pull", "db", "Secret"),
		e.groupLink("api", "app-api", "pull", "api", "ConfigMap"),
		e.groupLink("empty", "app-queue", "pull", "queue", "Secret"), // registered, no keys: nothing is written
	}
	e.poll(t)
	for _, id := range []string{"def", "db", "api", "empty"} {
		e.reconcile(t, id)
	}

	okLabels := map[string]bool{LinkLabel: true, ManagedByLabel: true}
	okAnnotations := map[string]bool{annSource: true, annDigest: true}
	check := func(what string, labels, annotations map[string]string, data map[string]string, want map[string]string) {
		t.Helper()
		for k, v := range labels {
			if !okLabels[k] {
				t.Errorf("%s: unexpected label %s=%s", what, k, v)
			}
		}
		for k, v := range annotations {
			if !okAnnotations[k] {
				t.Errorf("%s: unexpected annotation %s=%s", what, k, v)
			}
		}
		if !reflect.DeepEqual(data, want) {
			t.Errorf("%s: data = %v, want exactly the group's keys %v", what, keysOf(data), keysOf(want))
		}
		for k, v := range data { // no marker or group name sneaks in as a key or a value
			if strings.Contains(k, "@group") || strings.Contains(v, "@group") {
				t.Errorf("%s: %s=%s", what, k, v)
			}
		}
	}
	exp := e.v.Environment.Expected
	for _, c := range []struct {
		name string
		keys []string
	}{{"app-default", []string{"MULTILINE", "UNICODE"}}, {"app-db", []string{"DATABASE_URL"}}} {
		s, ok := e.secret("prod", c.name)
		if !ok {
			t.Fatalf("%s was not created", c.name)
		}
		want := map[string]string{}
		for _, k := range c.keys {
			want[k] = exp[k]
		}
		got := map[string]string{}
		for k, v := range s.Data {
			got[k] = string(v)
		}
		check(c.name, s.Labels, s.Annotations, got, want)
	}
	cm, ok := e.configMap("prod", "app-api")
	if !ok {
		t.Fatal("app-api was not created")
	}
	check("app-api", cm.Labels, cm.Annotations, cm.Data, map[string]string{"API_KEY": exp["API_KEY"], "EMPTY": exp["EMPTY"]})
	if len(cm.BinaryData) != 0 {
		t.Errorf("binary data = %v", cm.BinaryData)
	}
	if _, ok := e.secret("prod", "app-queue"); ok {
		t.Error("a group with no keys wrote a Secret")
	}
}
