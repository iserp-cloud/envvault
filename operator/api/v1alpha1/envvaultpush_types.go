package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// EnvVaultPushSpec says which Secret to push and which environment receives it.
type EnvVaultPushSpec struct {
	// TokenSecretRef holds a service token (evt_…) that has write access to the environment.
	TokenSecretRef SecretKeyRef `json:"tokenSecretRef"`
	// Project the environment belongs to.
	// +kubebuilder:validation:MinLength=1
	Project string `json:"project"`
	// Environment to write to. It must already exist: a service token cannot create one.
	// +kubebuilder:validation:MinLength=1
	Environment string `json:"environment"`
	// SourceSecretName is a Secret in this namespace. Each of its keys is written to the environment.
	// +kubebuilder:validation:MinLength=1
	SourceSecretName string `json:"sourceSecretName"`
	// RefreshInterval between checks (minimum 10s, default 60s).
	// +optional
	RefreshInterval *metav1.Duration `json:"refreshInterval,omitempty"`
	// Hub overrides the hub address and how to trust it.
	// +optional
	Hub HubSpec `json:"hub,omitempty"`
}

// EnvVaultPushStatus reports the last push. It never contains values.
type EnvVaultPushStatus struct {
	// ObservedVersion is the hub version after the last push or check.
	// +optional
	ObservedVersion string `json:"observedVersion,omitempty"`
	// SourceDigest identifies the source Secret contents that were last pushed.
	// +optional
	SourceDigest string `json:"sourceDigest,omitempty"`
	// KeyCount is how many keys the source Secret holds.
	// +optional
	KeyCount int `json:"keyCount,omitempty"`
	// LastPushTime is when the hub was last written to.
	// +optional
	LastPushTime *metav1.Time `json:"lastPushTime,omitempty"`
	// ConsecutiveFailures counts failed attempts in a row; the operator backs off while it is above zero.
	// +optional
	ConsecutiveFailures int `json:"consecutiveFailures,omitempty"`
	// TokenExpiresAt is when the service token stops working, if the hub says.
	// +optional
	TokenExpiresAt *metav1.Time `json:"tokenExpiresAt,omitempty"`
	// ExpiryWarnedDays is the nearest expiry warning already raised (14, 7, 3 or 1 days).
	// +optional
	ExpiryWarnedDays int `json:"expiryWarnedDays,omitempty"`
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=evp
// +kubebuilder:printcolumn:name="Project",type=string,JSONPath=`.spec.project`
// +kubebuilder:printcolumn:name="Env",type=string,JSONPath=`.spec.environment`
// +kubebuilder:printcolumn:name="Source",type=string,JSONPath=`.spec.sourceSecretName`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Reason",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].reason`
// +kubebuilder:printcolumn:name="Pushed",type=date,JSONPath=`.status.lastPushTime`

// EnvVaultPush writes the keys of a Kubernetes Secret into an EnvVault environment.
// Keys the Secret does not have are left alone on the hub; nothing is ever deleted there.
type EnvVaultPush struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   EnvVaultPushSpec   `json:"spec,omitempty"`
	Status EnvVaultPushStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// EnvVaultPushList is a list of EnvVaultPush.
type EnvVaultPushList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []EnvVaultPush `json:"items"`
}

func init() {
	SchemeBuilder.Register(&EnvVaultPush{}, &EnvVaultPushList{})
}
