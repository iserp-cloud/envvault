import {
  changePasswordProc,
  health,
  login,
  me,
  prelogin,
  recoverProc,
  recoveryBundleProc,
  sessionsList,
  sessionsRevoke,
  sessionsRevokeOthers,
  setRecoveryProc,
  signup,
  status,
  usersResolve,
} from "./procedures/auth.js";
import { adminAuditList, adminAuditVerify, tenantsAudit } from "./procedures/audit.js";
import {
  serviceAccountsCreate,
  serviceAccountsList,
  serviceAccountsRevoke,
} from "./procedures/service.js";
import {
  k8sAgentReport,
  k8sAgentSync,
  k8sClustersExtend,
  k8sClustersLinks,
  k8sClustersList,
  k8sClustersReplace,
  k8sLinksAdopt,
  k8sLinksCreate,
  k8sLinksDelete,
  k8sLinksList,
} from "./procedures/k8s.js";
import {
  adminInvitesCreate,
  adminInvitesList,
  adminInvitesRevoke,
  adminUsersList,
  adminUsersSetRole,
  adminUsersSetStatus,
} from "./procedures/admin.js";
import {
  tenantsAcceptInvite,
  tenantsCreate,
  tenantsDeclineInvite,
  tenantsDelete,
  tenantsInvite,
  tenantsInvites,
  tenantsKeyRecipients,
  tenantsList,
  tenantsMembers,
  tenantsRemoveMember,
} from "./procedures/tenants.js";
import {
  createProject,
  deleteProjectProc,
  listProjectsProc,
} from "./procedures/projects.js";
import {
  environmentsCreate,
  environmentsDelete,
  environmentsGetEnv,
  environmentsGrantAccess,
  environmentsList,
  environmentsListAccess,
  environmentsRotate,
  environmentsSaveEnv,
  environmentsVersionsDelete,
  environmentsVersionsExport,
  environmentsVersionsGet,
  environmentsVersionsList,
} from "./procedures/environments.js";

export const appRouter = {
  health,
  status,
  prelogin,
  signup,
  login,
  me,
  changePassword: changePasswordProc,
  sessions: {
    list: sessionsList,
    revoke: sessionsRevoke,
    revokeOthers: sessionsRevokeOthers,
  },
  recovery: {
    bundle: recoveryBundleProc,
    recover: recoverProc,
    set: setRecoveryProc,
  },
  users: {
    resolve: usersResolve,
  },
  admin: {
    audit: { list: adminAuditList, verify: adminAuditVerify },
    users: {
      list: adminUsersList,
      setStatus: adminUsersSetStatus,
      setRole: adminUsersSetRole,
    },
    invites: {
      create: adminInvitesCreate,
      list: adminInvitesList,
      revoke: adminInvitesRevoke,
    },
  },
  tenants: {
    list: tenantsList,
    create: tenantsCreate,
    members: tenantsMembers,
    invite: tenantsInvite,
    invites: tenantsInvites,
    acceptInvite: tenantsAcceptInvite,
    declineInvite: tenantsDeclineInvite,
    removeMember: tenantsRemoveMember,
    delete: tenantsDelete,
    keyRecipients: tenantsKeyRecipients,
    audit: tenantsAudit,
  },
  k8s: {
    links: { create: k8sLinksCreate, list: k8sLinksList, delete: k8sLinksDelete, adopt: k8sLinksAdopt },
    clusters: { list: k8sClustersList, extend: k8sClustersExtend, links: k8sClustersLinks, replace: k8sClustersReplace },
    agent: { sync: k8sAgentSync, report: k8sAgentReport },
  },
  serviceAccounts: {
    create: serviceAccountsCreate,
    list: serviceAccountsList,
    revoke: serviceAccountsRevoke,
  },
  projects: {
    list: listProjectsProc,
    create: createProject,
    delete: deleteProjectProc,
  },
  environments: {
    list: environmentsList,
    create: environmentsCreate,
    delete: environmentsDelete,
    getEnv: environmentsGetEnv,
    saveEnv: environmentsSaveEnv,
    rotate: environmentsRotate,
    grantAccess: environmentsGrantAccess,
    listAccess: environmentsListAccess,
    versions: {
      list: environmentsVersionsList,
      get: environmentsVersionsGet,
      delete: environmentsVersionsDelete,
      export: environmentsVersionsExport,
    },
  },
};

export type AppRouter = typeof appRouter;
