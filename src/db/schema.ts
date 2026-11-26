/** Kysely database schema — shared by the Node server and the Cloudflare worker. */
export interface Database {
  settings: SettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  invites: InvitesTable;
  audit_log: AuditLogTable;
  rate_limits: RateLimitsTable;
  tenants: TenantsTable;
  tenant_members: TenantMembersTable;
  projects: ProjectsTable;
  environments: EnvironmentsTable;
  environment_versions: EnvironmentVersionsTable;
  environment_keys: EnvironmentKeysTable;
  environment_acl: EnvironmentAclTable;
  k8s_links: K8sLinksTable;
  k8s_clusters: K8sClustersTable;
}

export interface SettingsTable {
  key: string;
  value: string;
}

export interface UsersTable {
  username: string;
  /** user = human with a password; service = machine account authenticated by a token */
  kind: "user" | "service";
  /** base64url random salt for the stored login-proof hash */
  auth_salt: string;
  /** base64url hash of the client-derived authKey (never the password). Unusable for service accounts. */
  auth_hash: string;
  /** JSON KdfParams the client used to stretch the password */
  kdf: string;
  /** Base64 SPKI RSA public key */
  public_key: string;
  /** JSON SealedBox of the PKCS8 private key, sealed client-side with the wrap key ('' for service accounts) */
  wrapped_private_key: string;
  /** Recovery: salted hash of the client-derived recovery proof ('' if unset) */
  recovery_salt: string;
  recovery_hash: string;
  /** JSON SealedBox of the private key sealed with the recovery key */
  recovery_wrapped_private_key: string;
  /** Instance role: admins manage users and invites */
  role: "admin" | "member";
  status: "active" | "disabled";
  /** Service accounts belong to one workspace */
  service_tenant: string | null;
  created_by: string | null;
  created_at: string;
}

/** One row per concurrent login. Token stored as SHA-256 hex. */
export interface SessionsTable {
  token: string;
  username: string;
  created_at: string;
  expires_at: string;
  ip: string;
  user_agent: string;
}

/** Single-use signup invites. Only a hash of the token is stored. */
export interface InvitesTable {
  id: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  note: string;
  /** Optional workspace the new user is invited to join */
  tenant_id: string | null;
  tenant_role: "admin" | "member" | null;
  used_at: string | null;
  used_by: string | null;
  revoked_at: string | null;
}

/** Append-only activity log. Never contains secrets or plaintext values. */
export interface AuditLogTable {
  id: string;
  at: string;
  actor: string;
  action: string;
  tenant_id: string | null;
  /** What was acted on, e.g. "billing/prod" or a username */
  target: string;
  detail: string;
  ip: string;
  /** HMAC over the row (keyed by ENVVAULT_PEPPER) so edits by someone with only DB access are detectable */
  mac: string;
}

export interface RateLimitsTable {
  key: string;
  count: number;
  reset_at: string;
}

export interface TenantsTable {
  id: string;
  /** Unique public handle (shared namespace with usernames). Always lowercase. */
  slug: string;
  name: string;
  owner_username: string;
  /** personal = one per user; org = shared workspace */
  kind: "personal" | "org";
  created_at: string;
}

export interface TenantMembersTable {
  tenant_id: string;
  username: string;
  role: "owner" | "admin" | "member";
  status: "pending" | "active";
}

export interface ProjectsTable {
  tenant_id: string;
  name: string;
  updated_at: string;
}

export interface EnvironmentsTable {
  tenant_id: string;
  project_name: string;
  name: string;
  updated_at: string;
  /** JSON SealedBox — ciphertext only; the server never holds the key */
  payload: string;
  /** 1 when someone who knew the key was removed and the key has not been rotated yet */
  rotate_pending: number;
  /** Counts saves; the current payload is this version, older ones live in environment_versions. */
  version: number;
  /** Who wrote the current payload. */
  updated_by: string;
  /** Optional free-text note on the current payload (e.g. "Restored from v3"). */
  note: string;
  /** Counts key rotations. A wrapped key is only valid for the generation it was made for. */
  key_version: number;
}

/** A previous payload of an environment, still ciphertext under the environment's current key. */
export interface EnvironmentVersionsTable {
  id: string;
  tenant_id: string;
  project_name: string;
  env_name: string;
  version: number;
  /** JSON SealedBox */
  payload: string;
  /** When this version was written. */
  created_at: string;
  created_by: string;
  note: string;
}

export interface EnvironmentKeysTable {
  tenant_id: string;
  project_name: string;
  env_name: string;
  username: string;
  /** Base64 RSA-OAEP ciphertext of the environment DEK */
  wrapped_env_dek: string;
}

export interface EnvironmentAclTable {
  tenant_id: string;
  project_name: string;
  env_name: string;
  username: string;
  level: "read" | "write" | "manage";
  /** Comma list of extra capabilities (delete, share, rotate); empty for manage, which has them all. */
  caps: string;
}

export type UserRow = UsersTable;
export type SessionRow = SessionsTable;
export type InviteRow = InvitesTable;
export type AuditLogRow = AuditLogTable;
export type RateLimitRow = RateLimitsTable;
export type TenantRow = TenantsTable;
export type TenantMemberRow = TenantMembersTable;
export type ProjectRow = ProjectsTable;
export type EnvironmentRow = EnvironmentsTable;
export type EnvironmentKeyRow = EnvironmentKeysTable;
export type EnvironmentAclRow = EnvironmentAclTable;

/**
 * An environment linked to a Kubernetes Secret. Metadata only: the values never pass through here,
 * the operator in the cluster decrypts them with the cluster token's own key.
 */
export interface K8sLinksTable {
  id: string;
  tenant_id: string;
  project_name: string;
  env_name: string;
  /** The service account (cluster token) that carries this link out. */
  cluster: string;
  namespace: string;
  secret_name: string;
  /** pull = the Secret is written from the environment; push = the environment is written from the Secret. */
  direction: "pull" | "push";
  created_by: string;
  created_at: string;
  /** What the operator last reported; empty until it has. */
  status: string;
  status_message: string;
  key_count: number;
  reported_at: string;
  /** 1 = a pull may take over a Secret that already exists in the cluster (0 = it refuses to touch one it did not write). */
  adopt: number;
  /** Which of the environment's key groups this link carries: "default" is every key that has no group. */
  group_name: string;
  /** What the link writes (pull) or reads (push): a Secret, or a ConfigMap (pull only). */
  target_kind: "Secret" | "ConfigMap";
}

/** A cluster's operator, as last seen. */
export interface K8sClustersTable {
  /** The cluster token's username. */
  cluster: string;
  tenant_id: string;
  last_seen: string;
  version: string;
  /** JSON array of the namespaces the operator may use. */
  namespaces: string;
  /** When the cluster token stops working, as the operator says; empty when unknown. */
  token_expires_at: string;
}

export type K8sLinkRow = K8sLinksTable;
export type K8sClusterRow = K8sClustersTable;
