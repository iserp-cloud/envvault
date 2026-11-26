package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// SecretKeyRef points at one key of a Secret in the same namespace.
type SecretKeyRef struct {
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
	// Key inside the Secret. Defaults to `token` for the service token and `ca.crt` for a CA bundle.
	// +optional
	Key string `json:"key,omitempty"`
}

// TargetSpec is the Kubernetes Secret (or ConfigMap) the operator writes.
type TargetSpec struct {
	// Kind of object to write: a Secret (the default) or a ConfigMap, for settings that are not sensitive.
	// +kubebuilder:validation:Enum=Secret;ConfigMap
	// +kubebuilder:default=Secret
	// +optional
	Kind string `json:"kind,omitempty"`
	// Name of the Secret or ConfigMap. Defaults to the name of this resource.
	// +optional
	Name string `json:"name,omitempty"`
	// Type of the Secret. Ignored for a ConfigMap.
	// +kubebuilder:default=Opaque
	// +optional
	Type string `json:"type,omitempty"`
}

// HubSpec overrides how the operator reaches and trusts the hub.
type HubSpec struct {
	// URL of the hub. Defaults to the address inside the service token.
	// +optional
	URL string `json:"url,omitempty"`
	// CASecretRef holds a PEM bundle to trust, e.g. the hub's self-signed certificate.
	// +optional
	CASecretRef *SecretKeyRef `json:"caSecretRef,omitempty"`
	// Fingerprint pins the hub's certificate (SHA-256, hex, colons optional). The hub prints it at start-up.
	// +optional
	Fingerprint string `json:"fingerprint,omitempty"`
	// InsecureSkipVerify disables certificate checks. For testing only.
	// +optional
	InsecureSkipVerify bool `json:"insecureSkipVerify,omitempty"`
	// AllowPlainHTTP permits an http:// hub. The token would cross the network in the clear.
	// +optional
	AllowPlainHTTP bool `json:"allowPlainHTTP,omitempty"`
}

// WorkloadRef names a workload in the same namespace to roll when the secret changes.
type WorkloadRef struct {
	// +kubebuilder:validation:Enum=Deployment;StatefulSet;DaemonSet
	Kind string `json:"kind"`
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
}

// EnvVaultSecretSpec says which environment to read and where to put it.
type EnvVaultSecretSpec struct {
	// TokenSecretRef holds the service token (evt_…) created in the EnvVault dashboard.
	TokenSecretRef SecretKeyRef `json:"tokenSecretRef"`
	// Project the environment belongs to.
	// +kubebuilder:validation:MinLength=1
	Project string `json:"project"`
	// Environment to read, e.g. `production`.
	// +kubebuilder:validation:MinLength=1
	Environment string `json:"environment"`
	// Group is the key group to write: the keys of the environment that were put in this group in the
	// dashboard. Empty or `default` means the keys that have no group, which is every key until groups are used.
	// +kubebuilder:validation:MaxLength=40
	// +optional
	Group string `json:"group,omitempty"`
	// Target Secret or ConfigMap to create and keep up to date.
	// +optional
	Target TargetSpec `json:"target,omitempty"`
	// RefreshInterval between checks of the hub (minimum 10s, default 60s). Only a change is downloaded.
	// +optional
	RefreshInterval *metav1.Duration `json:"refreshInterval,omitempty"`
	// Hub overrides the hub address and how to trust it.
	// +optional
	Hub HubSpec `json:"hub,omitempty"`
	// RestartOn lists workloads to roll (by changing a pod-template annotation) when the values change.
	// +optional
	RestartOn []WorkloadRef `json:"restartOn,omitempty"`
}

// EnvVaultSecretStatus reports the last sync. It never contains values.
type EnvVaultSecretStatus struct {
	// ObservedVersion is the hub version last written to the Secret.
	// +optional
	ObservedVersion string `json:"observedVersion,omitempty"`
	// KeyCount is how many keys the Secret holds.
	// +optional
	KeyCount int `json:"keyCount,omitempty"`
	// LastSyncTime is when the Secret was last written.
	// +optional
	LastSyncTime *metav1.Time `json:"lastSyncTime,omitempty"`
	// ConsecutiveFailures counts failed syncs in a row. While it is above zero the operator
	// backs off (up to 5 minutes) instead of retrying at the refresh interval.
	// +optional
	ConsecutiveFailures int `json:"consecutiveFailures,omitempty"`
	// TokenExpiresAt is when the service token stops working, if the hub says.
	// +optional
	TokenExpiresAt *metav1.Time `json:"tokenExpiresAt,omitempty"`
	// ExpiryWarnedDays is the nearest expiry warning already raised (14, 7, 3 or 1 days).
	// +optional
	ExpiryWarnedDays int `json:"expiryWarnedDays,omitempty"`
	// ObservedGeneration is the spec generation the conditions describe.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=evs
// +kubebuilder:printcolumn:name="Project",type=string,JSONPath=`.spec.project`
// +kubebuilder:printcolumn:name="Env",type=string,JSONPath=`.spec.environment`
// +kubebuilder:printcolumn:name="Keys",type=integer,JSONPath=`.status.keyCount`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Reason",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].reason`
// +kubebuilder:printcolumn:name="Synced",type=date,JSONPath=`.status.lastSyncTime`

// EnvVaultSecret keeps a Kubernetes Secret in step with one EnvVault environment.
type EnvVaultSecret struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   EnvVaultSecretSpec   `json:"spec,omitempty"`
	Status EnvVaultSecretStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// EnvVaultSecretList is a list of EnvVaultSecret.
type EnvVaultSecretList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []EnvVaultSecret `json:"items"`
}

func init() {
	SchemeBuilder.Register(&EnvVaultSecret{}, &EnvVaultSecretList{})
}
