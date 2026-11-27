import { useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  ChevronsUpDown,
  Copy,
  ShieldCheck,
  Ellipsis,
  Eye,
  EyeOff,
  Folder,
  History,
  FolderOpen,
  KeyRound,
  Lock,
  LogOut,
  Menu,
  Plus,
  Settings,
  Tags,
  Trash2,
  Upload,
} from "lucide-react";
import {
  createEnvironment,
  createProject,
  deleteEnvironment,
  deleteProject,
  getEnv,
  listEnvironmentAccess,
  listEnvironments,
  listInvites,
  listProjects,
  listTenantMembers,
  listTenants,
  resetKeyPins,
  rotateEnvironmentNow,
  saveEnv,
  saveSession,
  type AccessEntry,
  type EnvMeta,
  type ProjectMeta,
  type Session,
  type TenantInvite,
  type TenantMember,
  type TenantMeta,
} from "@/api";
import { cleanLabels, describeAccess, groupCounts, hasCap, knownGroups, validateGroupName } from "@envvault/shared";
import { GroupRegistry } from "@/components/GroupRegistry";
import { AdminPage } from "@/components/AdminPage";
import { Fingerprint } from "@/components/Fingerprint";
import { RecoveryKeyPanel } from "@/components/RecoveryKeyPanel";
import { Logo } from "@/components/Logo";
import { EnvHistory } from "@/components/EnvHistory";
import { EnvironmentCombobox } from "@/components/EnvironmentCombobox";
import { KubernetesLinks } from "@/components/KubernetesLinks";
import { InvitesBanner } from "@/components/InvitesBanner";
import { PasswordDialog } from "@/components/PasswordDialog";
import { RecoveryKeyDialog } from "@/components/RecoveryKeyDialog";
import { ProjectVisibility } from "@/components/ProjectVisibility";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TenantSettings } from "@/components/TenantSettings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isUnauthorized } from "@/lib/auth-errors";
import { useLivePolling } from "@/lib/live";
import { formatRoute, parseRoute, type AppPage, type ProjectPane } from "@/lib/route";
import { formatDate, rowsToEnv, rowsToGroups, toRows, type EnvRow } from "@/lib/env-rows";
import {
  detectAndParseImport,
  serializeEnvExport,
  serializeJsonExport,
  type ImportFormat,
} from "./env-import";
import { useConfirm } from "@/components/ConfirmDialog";


type Props = {
  session: Session;
  onLock: () => void;
  onSignOut: () => void;
  onSessionUpdate: (session: Session) => void;
  onAuthFailure: () => void;
};

/** Browsers that can mask a plain text field with CSS: used instead of a password field (see the value cells). */
const MASK_WITH_CSS = typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");

/** Keep the previous value (so React skips the re-render and dependent effects) when equal. */
function unchanged<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

export function VaultApp({ session, onLock, onSignOut, onSessionUpdate, onAuthFailure }: Props) {
  const confirm = useConfirm();
  // Where you were before a refresh, from the URL hash (see lib/route.ts).
  const [start] = useState(() => parseRoute(window.location.hash));
  const [page, setPage] = useState<AppPage>(start.page);
  const [projectPane, setProjectPane] = useState<ProjectPane>(start.pane);
  // The panel is reset when a different environment is opened, not when the same one reloads (a refresh keeps
  // the panel the URL named).
  const loadedEnvKey = useRef<string | null>(start.project && start.env ? `${start.project}\0${start.env}` : null);
  const [tenants, setTenants] = useState<TenantMeta[]>([]);
  const [invites, setInvites] = useState<TenantInvite[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(start.project);
  const [environments, setEnvironments] = useState<EnvMeta[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<string | null>(start.env);
  const [envDek, setEnvDek] = useState<string | null>(null);
  const [accessLevel, setAccessLevel] = useState<"read" | "write" | "manage">("read");
  const [accessCaps, setAccessCaps] = useState("");
  const [projectCanManage, setProjectCanManage] = useState(false);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [baseline, setBaseline] = useState("");
  const [baselineGroups, setBaselineGroups] = useState("{}");
  const [labels, setLabels] = useState<string[]>([]);
  /** Which group the key list shows: "" for all of them. */
  const [groupFilter, setGroupFilter] = useState("");
  const [baselineLabels, setBaselineLabels] = useState("[]");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importHint, setImportHint] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  /** Label for the next save, set when a draft was restored from an older version. */
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [accessList, setAccessList] = useState<AccessEntry[]>([]);
  const [newEnvName, setNewEnvName] = useState("");
  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);

  const knownInvites = useRef<Set<string> | null>(null);
  const projectsJson = useRef("");
  const skipEnvReload = useRef(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const savedEnv = useMemo<Record<string, string>>(() => {
    try {
      return baseline ? (JSON.parse(baseline) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }, [baseline]);

  const dirty = useMemo(
    () =>
      JSON.stringify(rowsToEnv(rows)) !== baseline ||
      JSON.stringify(rowsToGroups(rows)) !== baselineGroups ||
      JSON.stringify(cleanLabels(labels)) !== baselineLabels,
    [rows, baseline, baselineGroups, labels, baselineLabels],
  );
  // Every group a key can be given: the registry plus the ones already in use.
  const groupChoices = useMemo(() => knownGroups(labels, rowsToGroups(rows)), [labels, rows]);
  const groupsInUse = useMemo(() => {
    const vars = rowsToEnv(rows);
    return Object.fromEntries(groupCounts(vars, rowsToGroups(rows)).filter((g) => g.group !== "default").map((g) => [g.group, g.keys]));
  }, [rows]);
  /** The group buttons above the key list: every group in use or registered, with how many keys each holds. */
  const groupTabs = useMemo(() => {
    const counts = new Map<string, number>([["default", 0]]);
    for (const g of groupChoices) counts.set(g, 0);
    for (const r of rows) {
      const g = r.group.trim().toLowerCase() || "default";
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts].map(([group, keys]) => ({ group, keys }));
  }, [groupChoices, rows]);
  // a filter on a group that has gone (no keys, not registered) shows everything again
  const activeFilter = groupTabs.some((t) => t.group === groupFilter) ? groupFilter : "";
  const visibleRows = activeFilter
    ? rows.filter((r) => (r.group.trim().toLowerCase() || "default") === activeFilter)
    : rows;
  const canWrite = accessLevel === "write" || accessLevel === "manage";
  const canShareEnv = hasCap(accessLevel, accessCaps, "share");
  const canRotateEnv = hasCap(accessLevel, accessCaps, "rotate");
  const canRemoveFromEnv = hasCap(accessLevel, accessCaps, "delete");
  /** The access pane is for anyone who may share or re-key; each action inside checks its own. */
  const canManageEnv = canShareEnv || canRotateEnv;
  const canDeleteEnv = canRemoveFromEnv && environments.length > 1;
  const activeTenant = tenants.find((t) => t.id === session.activeTenantId);
  const isOrg = activeTenant?.kind === "org";
  const canInvite =
    isOrg && (activeTenant?.role === "owner" || activeTenant?.role === "admin");
  const canCreateProject =
    activeTenant?.role === "owner" || activeTenant?.role === "admin";

  const detectedPreview = useMemo(() => {
    if (!importText.trim()) return null;
    try {
      const result = detectAndParseImport(importText);
      return {
        format: result.format as ImportFormat,
        count: Object.keys(result.env).length,
        groups: result.hasGroups ? new Set(Object.values(result.groups)).size : 0,
        error: null as string | null,
      };
    } catch (err) {
      return {
        format: null as ImportFormat | null,
        count: 0,
        groups: 0,
        error: err instanceof Error ? err.message : "Invalid input",
      };
    }
  }, [importText]);

  /** `notify`: this is a background poll, so announce invitations we haven't seen before. */
  async function refreshTenants(notify = false) {
    const [list, pending] = await Promise.all([
      listTenants(session),
      listInvites(session),
    ]);
    setTenants((prev) => unchanged(prev, list));
    setInvites((prev) => unchanged(prev, pending));
    const known = knownInvites.current;
    if (notify && known) {
      const fresh = pending.filter((i) => !known.has(i.id));
      if (fresh.length > 0) {
        setStatus(
          fresh.length === 1
            ? `New invitation to ${fresh[0]!.name}`
            : `${fresh.length} new invitations`,
        );
      }
    }
    knownInvites.current = new Set(pending.map((i) => i.id));
    if (!list.some((t) => t.id === session.activeTenantId) && list[0]) {
      const next = { ...session, activeTenantId: list[0].id };
      saveSession(next);
      onSessionUpdate(next);
    }
    return list;
  }

  async function refreshMembers(tenantId = session.activeTenantId) {
    try {
      const m = await listTenantMembers(session, tenantId);
      setMembers(m);
      return m;
    } catch {
      setMembers([]);
      return [];
    }
  }

  async function refreshProjects(prefer?: string) {
    const list = await listProjects(session);
    projectsJson.current = JSON.stringify(list);
    setProjects(list);
    const next =
      prefer && list.some((p) => p.name === prefer)
        ? prefer
        : selected && list.some((p) => p.name === selected)
          ? selected
          : (list[0]?.name ?? null);
    setSelected(next);
    return next;
  }

  async function refreshEnvironments(projectName: string, prefer?: string) {
    const list = await listEnvironments(session, projectName);
    setEnvironments(list);
    const meta = projects.find((p) => p.name === projectName);
    setProjectCanManage(Boolean(meta?.canManage));
    const next =
      prefer && list.some((e) => e.name === prefer)
        ? prefer
        : selectedEnv && list.some((e) => e.name === selectedEnv)
          ? selectedEnv
          : (list[0]?.name ?? null);
    setSelectedEnv(next);
    return { list, selected: next };
  }

  async function loadEnv(
    projectName: string,
    envName: string,
    dek: string,
    level: EnvMeta["level"],
    caps: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      const envData = await getEnv(session, projectName, envName, dek);
      setRows(toRows(envData.env, envData.groups));
      setBaseline(JSON.stringify(envData.env));
      setBaselineGroups(JSON.stringify(rowsToGroups(toRows(envData.env, envData.groups))));
      setLabels(envData.labels);
      setBaselineLabels(JSON.stringify(cleanLabels(envData.labels)));
      setGroupsOpen(false);
      setUpdatedAt(envData.updatedAt);
      setEnvDek(dek);
      setAccessLevel(level);
      setAccessCaps(caps);
      setStatus(null);
      setImportOpen(false);
      setImportText("");
      setImportHint(null);
      setPendingNote(null);
      const envKey = `${projectName}\0${envName}`;
      if (loadedEnvKey.current !== envKey) setProjectPane("env");
      loadedEnvKey.current = envKey;
      if (hasCap(level, caps, "share") || hasCap(level, caps, "rotate")) {
        setAccessList(await listEnvironmentAccess(session, projectName, envName));
      } else {
        setAccessList([]);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load environment");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Background refresh: pick up invitations, accepted invites and newly shared projects
   * without a reload. It must never disturb what the user is doing, so it only writes state
   * that actually changed and never reloads (or resets) the open environment.
   */
  async function pollOnce() {
    const [list, members] = await Promise.all([
      listProjects(session),
      // Unlike refreshMembers, a failed poll keeps what's on screen instead of blanking it.
      listTenantMembers(session, session.activeTenantId).catch((err) => {
        if (isUnauthorized(err)) throw err;
        return null;
      }),
      refreshTenants(true),
    ]).then(([l, m]) => [l, m] as const);
    if (members) setMembers((prev) => unchanged(prev, members));

    const json = JSON.stringify(list);
    if (json === projectsJson.current) return;
    projectsJson.current = json;
    const cur = selectedRef.current;
    const needsSelection = cur === null ? list.length > 0 : !list.some((p) => p.name === cur);
    // Same project still selected: refresh the list quietly, leave the editor alone.
    if (!needsSelection) {
      skipEnvReload.current = true;
      setProjectCanManage(Boolean(list.find((p) => p.name === cur)?.canManage));
    }
    setProjects(list);
    if (needsSelection) setSelected(list[0]?.name ?? null);
  }

  useLivePolling(async () => {
    try {
      await pollOnce();
    } catch (err) {
      if (isUnauthorized(err)) onAuthFailure();
      // Anything else (offline, a blip) is retried on the next tick.
    }
  }, 10_000);

  useEffect(() => {
    Promise.all([refreshTenants(), refreshProjects()])
      .then(async () => {
        await refreshMembers();
      })
      .catch((err) => {
        if (isUnauthorized(err)) {
          onAuthFailure();
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load vault");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.activeTenantId]);

  useEffect(() => {
    // A background poll refreshed the project list only: don't reload the open environment.
    if (skipEnvReload.current) {
      skipEnvReload.current = false;
      return;
    }
    if (selected) {
      void refreshEnvironments(selected).catch((err) => {
        if (isUnauthorized(err)) {
          onAuthFailure();
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load environments");
      });
    } else {
      setEnvironments([]);
      setSelectedEnv(null);
      setRows([]);
      setBaseline("");
      setUpdatedAt(null);
      setEnvDek(null);
      setProjectPane("env");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, projects]);

  useEffect(() => {
    if (selected && selectedEnv) {
      const meta = environments.find((e) => e.name === selectedEnv);
      if (meta?.envDek) {
        void loadEnv(selected, selectedEnv, meta.envDek, meta.level, meta.caps);
      }
    } else {
      setRows([]);
      setBaseline("");
      setUpdatedAt(null);
      setEnvDek(null);
      setProjectPane("env");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedEnv, environments]);

  // Keep the URL in step with where you are, without adding history entries.
  useEffect(() => {
    const hash = formatRoute({ page, project: selected, env: selectedEnv, pane: projectPane });
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, [page, selected, selectedEnv, projectPane]);

  async function onSwitchTenant(tenantId: string) {
    const next = { ...session, activeTenantId: tenantId };
    saveSession(next);
    onSessionUpdate(next);
    setSelected(null);
    setSelectedEnv(null);
    setPage("projects");
  }

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await createProject(session, name);
      setNewName("");
      await refreshProjects(project.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateEnvironment() {
    const name = newEnvName.trim();
    if (!selected || !name) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createEnvironment(session, selected, name);
      setNewEnvName("");
      setEnvDialogOpen(false);
      await refreshEnvironments(selected, created.name);
      setStatus(`Created environment "${created.name}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create environment failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    if (!selected || !selectedEnv || !envDek || !canWrite) return;
    setBusy(true);
    setError(null);
    try {
      const env = rowsToEnv(rows);
      const groups = rowsToGroups(rows);
      const bad = Object.values(groups).map(validateGroupName).find((m) => m !== null);
      if (bad) throw new Error(bad);
      const saved = await saveEnv(session, selected, selectedEnv, env, { groups, labels }, envDek, updatedAt, pendingNote ?? undefined);
      setPendingNote(null);
      setRows(toRows(saved.env, saved.groups));
      setBaseline(JSON.stringify(saved.env));
      setBaselineGroups(JSON.stringify(saved.groups));
      setLabels(saved.labels);
      setBaselineLabels(JSON.stringify(saved.labels));
      setUpdatedAt(saved.updatedAt);
      setStatus("Saved");
      await refreshProjects(selected);
      await refreshEnvironments(selected, selectedEnv);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  /** Load an older version into the editor as an unsaved draft (saving it adds a new version). */
  async function onRestoreVersion(env: Record<string, string>, grouping: { groups: Record<string, string>; labels: string[] }, version: number) {
    if (dirty) {
      const ok = await confirm({
        title: "Replace your unsaved edits?",
        description: `Version ${version} will be loaded into the editor instead.`,
        confirmLabel: "Replace edits",
        destructive: true,
      });
      if (!ok) return;
    }
    setRows(toRows(env, grouping.groups));
    setLabels(grouping.labels);
    setPendingNote(`Restored from v${version}`);
    setProjectPane("env");
    setStatus(null);
    setError(null);
  }

  async function onDeleteEnvironment() {
    if (!selected || !selectedEnv || !canDeleteEnv) return;
    const ok = await confirm({
      title: `Delete environment "${selectedEnv}"?`,
      description: `It will be removed from "${selected}" along with its version history. This cannot be undone.`,
      confirmLabel: "Delete environment",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteEnvironment(session, selected, selectedEnv);
      setSelectedEnv(null);
      await refreshEnvironments(selected);
      setStatus("Environment deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete environment failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!selected || !projectCanManage) return;
    const ok = await confirm({
      title: `Delete project "${selected}"?`,
      description: "Every environment and its version history will be removed. This cannot be undone.",
      confirmLabel: "Delete project",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProject(session, selected);
      setSelected(null);
      setSelectedEnv(null);
      await refreshProjects();
      setStatus("Deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  function updateRow(id: string, patch: Partial<EnvRow>) {
    if (!canWrite && ("key" in patch || "value" in patch || "group" in patch)) return;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setStatus(null);
  }

  function addRow() {
    if (!canWrite) return;
    setRows((prev) => [
      ...prev,
      { id: `new-${Date.now()}`, key: "", value: "", revealed: true, group: activeFilter === "default" ? "" : activeFilter },
    ]);
    setStatus(null);
  }

  function removeRow(id: string) {
    if (!canWrite) return;
    setRows((prev) => prev.filter((r) => r.id !== id));
    setStatus(null);
  }

  function applyImport(mode: "merge" | "replace") {
    if (!canWrite) return;
    setError(null);
    setImportHint(null);
    try {
      const found = detectAndParseImport(importText);
      const { format, env } = found;
      const next = mode === "replace" ? env : { ...rowsToEnv(rows), ...env };
      // Text that names groups decides the group of every key in it (keys outside any group go to default); text
      // that names none leaves the groups of keys that were already here alone.
      const before = rowsToGroups(rows);
      const groups = { ...before };
      if (found.hasGroups) for (const key of Object.keys(env)) delete groups[key];
      Object.assign(groups, found.groups);
      setRows(toRows(next, groups));
      // names from the text join the environment's list
      const added = Object.values(found.groups).filter((g) => !labels.includes(g));
      if (added.length) setLabels(cleanLabels([...labels, ...added]));
      const grouped = new Set(Object.values(found.groups)).size;
      setStatus(
        `Imported ${Object.keys(env).length} key(s) from ${format === "json" ? "JSON" : ".env"} (${mode})` +
          (grouped ? `, ${grouped} group${grouped === 1 ? "" : "s"}` : ""),
      );
      setImportOpen(false);
      setImportText("");
    } catch (err) {
      setImportHint(err instanceof Error ? err.message : "Import failed");
    }
  }

  function onExport(format: ImportFormat) {
    const env = rowsToEnv(rows);
    const groups = rowsToGroups(rows);
    const text = format === "json" ? serializeJsonExport(env, groups) : serializeEnvExport(env, groups);
    void navigator.clipboard.writeText(text).then(
      () => setStatus(`Copied as ${format === "json" ? "JSON" : ".env"}`),
      () => {
        setImportOpen(true);
        setImportText(text);
        setImportHint(`Export ready — copy from the box (${format})`);
      },
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r bg-sidebar transition-transform md:static md:w-64 md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <button
            type="button"
            className="flex items-center gap-2.5"
            onClick={() => {
              setPage("projects");
              setProjectPane("env");
              setSidebarOpen(false);
            }}
          >
            <Logo className="size-7" />
            <span className="text-[15px] font-semibold tracking-tight">EnvVault</span>
          </button>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <div className="px-3 pb-3">
          <Select value={session.activeTenantId} onValueChange={(v) => void onSwitchTenant(v)}>
            <SelectTrigger className="h-9 w-full bg-card">
              <SelectValue placeholder="Vault" />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.kind === "personal" ? "Personal" : t.slug || t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <nav className="space-y-0.5 px-3">
          {(
            [
              ["projects", "Projects", Folder],
              ["settings", "Settings", Settings],
              ...(session.role === "admin" ? [["admin", "Administration", ShieldCheck] as const] : []),
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setPage(id);
                if (id === "settings") void refreshMembers();
                else setSidebarOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                page === id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          {page === "projects" && (
            <>
              <div className="flex items-center justify-between px-5 pb-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Projects
                </h2>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {projects.length}
                </span>
              </div>

              {canCreateProject && (
                <div className="flex gap-1.5 px-3 pb-2">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="New project"
                    className="h-8 text-[13px]"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void onCreate();
                    }}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-8 shrink-0"
                    tooltip="Create project"
                    disabled={busy || !newName.trim()}
                    onClick={() => void onCreate()}
                  >
                    <Plus />
                  </Button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-3 pb-3">
                {projects.length === 0 ? (
                  <p className="px-2 py-3 text-[13px] text-muted-foreground">
                    No projects yet. Create one or ask for access.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {projects.map((p) => (
                      <li key={p.name}>
                        <button
                          type="button"
                          className={cn(
                            "group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                            selected === p.name ? "bg-accent" : "hover:bg-muted",
                          )}
                          onClick={() => {
                            // Re-clicking the open project must not clear the selected
                            // environment: the load effects only re-run when `selected` changes.
                            if (selected !== p.name) {
                              setSelected(p.name);
                              setSelectedEnv(null);
                            }
                            setProjectPane("env");
                            setSidebarOpen(false);
                          }}
                        >
                          <span
                            className={cn(
                              "grid size-7 shrink-0 place-items-center rounded-md text-xs font-semibold uppercase",
                              selected === p.name
                                ? "bg-primary text-primary-foreground"
                                : "bg-secondary text-secondary-foreground",
                            )}
                          >
                            {p.name.slice(0, 1)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                "block truncate text-[13px] font-medium",
                                selected === p.name && "text-accent-foreground",
                              )}
                            >
                              {p.name}
                            </span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {p.level} · {formatDate(p.updatedAt)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 border-t p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                <span className="grid size-8 place-items-center rounded-full bg-primary/15 text-xs font-semibold uppercase text-primary">
                  {session.username.slice(0, 2)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {session.username}
                </span>
                <ChevronsUpDown className="size-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-56">
              <DropdownMenuLabel>Account</DropdownMenuLabel>
              <div className="px-2 pb-2">
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Key fingerprint
                </span>
                <Fingerprint session={session} />
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
                Change password
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRecoveryDialogOpen(true)}>
                New recovery key
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  void (async () => {
                    const ok = await confirm({
                      title: "Reset trusted keys?",
                      description:
                        "Every remembered public key for this server is forgotten. You'll be asked to verify fingerprints again the next time you share.",
                      confirmLabel: "Reset keys",
                      destructive: true,
                    });
                    if (!ok) return;
                    resetKeyPins();
                    setStatus("Trusted keys reset");
                  })();
                }}
              >
                Reset trusted keys
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLock}>
                <Lock className="size-4" />
                Lock
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onSignOut}>
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
            <Menu />
          </Button>
          <Logo className="size-6" />
          <span className="text-sm font-semibold">EnvVault</span>
        </div>


      <InvitesBanner
        invites={invites}
        session={session}
        busy={busy}
        onAccepted={async (id) => {
          await refreshTenants();
          await onSwitchTenant(id);
        }}
        onDeclined={async () => {
          await refreshTenants();
        }}
        onError={setError}
      />

      {error && page === "settings" && (
        <div className="px-4 pt-4">
          <Alert variant="destructive" className="mx-auto max-w-3xl">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      {page === "admin" && session.role === "admin" ? (
        <div className="flex-1 overflow-y-auto">
          <AdminPage session={session} tenants={tenants} onAuthFailure={onAuthFailure} />
        </div>
      ) : page === "settings" ? (
        <div className="flex-1 overflow-y-auto">
        <TenantSettings
          session={session}
          activeTenant={activeTenant}
          members={members}
          canInvite={canInvite}
          busy={busy}
          onMembersChange={setMembers}
          onStatus={setStatus}
          onError={setError}
          onBusy={setBusy}
          onAuthFailure={onAuthFailure}
          listMembers={() => refreshMembers()}
          onOrgCreated={async (tenantId) => {
            await refreshTenants();
            await onSwitchTenant(tenantId);
          }}
          onOrgDeleted={async () => {
            const list = await refreshTenants();
            const personal =
              list.find((t) => t.kind === "personal")?.id ?? session.personalTenantId;
            await onSwitchTenant(personal);
            setPage("projects");
          }}
        />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {error && (
              <div className="px-4 pt-4">
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            )}

            {!selected ? (
              <div className="flex flex-1 items-center justify-center p-8 text-center">
                <div className="max-w-xs">
                  <div className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">
                    <FolderOpen className="size-6" />
                  </div>
                  <p className="mt-4 text-base font-semibold">Select a project</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Choose a project you have keys for, or create one as owner/admin.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 px-6 pb-0 pt-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-xl font-semibold tracking-tight">{selected}</h2>
                      <Badge variant="outline">{describeAccess(accessLevel, accessCaps)}</Badge>
                      {dirty && projectPane === "env" && (
                        <Badge variant="destructive">Unsaved changes</Badge>
                      )}
                      {status && !dirty && <Badge variant="success">{status}</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {updatedAt ? `Updated ${formatDate(updatedAt)}` : "—"}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {projectPane === "env" && (
                      <>
                        {canWrite && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setImportOpen((v) => !v);
                                setImportHint(null);
                              }}
                            >
                              <Upload />
                              Import
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setGroupsOpen((v) => !v)}>
                              <Tags />
                              Groups
                            </Button>
                            <Button variant="outline" size="sm" onClick={addRow}>
                              <Plus />
                              Add key
                            </Button>
                            <Button size="sm" disabled={busy || !dirty} onClick={() => void onSave()}>
                              Save changes
                            </Button>
                          </>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="icon" className="size-8" tooltip="More">
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => onExport("env")}>
                              <Copy className="size-4" />
                              Copy as .env
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onExport("json")}>
                              <Copy className="size-4" />
                              Copy as JSON
                            </DropdownMenuItem>
                            {(canDeleteEnv || projectCanManage) && <DropdownMenuSeparator />}
                            {canDeleteEnv && (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                disabled={busy}
                                onClick={() => void onDeleteEnvironment()}
                              >
                                <Trash2 className="size-4" />
                                Delete environment
                              </DropdownMenuItem>
                            )}
                            {projectCanManage && (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                disabled={busy}
                                onClick={() => void onDelete()}
                              >
                                <Trash2 className="size-4" />
                                Delete project
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                    {selectedEnv && envDek && (
                      <Button
                        variant={projectPane === "history" ? "secondary" : "outline"}
                        size="icon"
                        className="size-8"
                        tooltip={projectPane === "history" ? "Back to environment" : "Version history"}
                        onClick={() => setProjectPane((p) => (p === "history" ? "env" : "history"))}
                      >
                        <History />
                      </Button>
                    )}
                    {selectedEnv && envDek && canShareEnv && (
                      <Button
                        variant={projectPane === "kubernetes" ? "secondary" : "outline"}
                        size="icon"
                        className="size-8"
                        tooltip={projectPane === "kubernetes" ? "Back to environment" : "Kubernetes"}
                        onClick={() => setProjectPane((p) => (p === "kubernetes" ? "env" : "kubernetes"))}
                      >
                        <Boxes />
                      </Button>
                    )}
                    {canManageEnv && isOrg && (
                      <Button
                        variant={projectPane === "settings" ? "secondary" : "outline"}
                        size="icon"
                        className="size-8"
                        tooltip={
                          projectPane === "settings"
                            ? "Back to environment"
                            : "Environment access"
                        }
                        onClick={() =>
                          setProjectPane((p) => (p === "settings" ? "env" : "settings"))
                        }
                      >
                        <Settings />
                      </Button>
                    )}
                  </div>
                </div>

                {environments.find((e) => e.name === selectedEnv)?.rotatePending && canRotateEnv && envDek && (
                  <div className="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
                    <p className="min-w-0 flex-1 text-sm">
                      <strong>Key rotation pending.</strong> Someone who knew this environment&apos;s key was
                      removed. Rotate it so their copy of the key stops working, then change the secrets they saw.
                    </p>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setError(null);
                        void rotateEnvironmentNow(session, selected, selectedEnv!, envDek)
                          .then(async ({ droppedVersions }) => {
                            await refreshEnvironments(selected, selectedEnv ?? undefined);
                            setStatus(
                              droppedVersions
                                ? `Key rotated. ${droppedVersions} older saved version${droppedVersions === 1 ? "" : "s"} couldn't be carried over and ${droppedVersions === 1 ? "was" : "were"} dropped.`
                                : "Key rotated",
                            );
                          })
                          .catch((err) => setError(err instanceof Error ? err.message : "Rotation failed"))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Rotate key now
                    </Button>
                  </div>
                )}

                <div className="mt-4 flex items-center gap-3 border-b px-6 pb-3">
                  <span className="text-[13px] font-medium text-muted-foreground">Environment</span>
                  <EnvironmentCombobox
                    environments={environments}
                    value={selectedEnv}
                    disabled={busy}
                    onChange={(name) => {
                      setSelectedEnv(name);
                      setProjectPane("env");
                    }}
                    onCreate={
                      projectCanManage
                        ? (suggested) => {
                            setNewEnvName(suggested);
                            setEnvDialogOpen(true);
                          }
                        : undefined
                    }
                  />
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                  {projectPane === "history" && envDek && selectedEnv ? (
                    <EnvHistory
                      session={session}
                      projectName={selected}
                      environmentName={selectedEnv}
                      envDek={envDek}
                      savedEnv={savedEnv}
                      reloadKey={updatedAt}
                      canWrite={canWrite}
                      canDelete={canRemoveFromEnv}
                      onRestore={onRestoreVersion}
                      onStatus={setStatus}
                      onError={setError}
                      onAuthFailure={onAuthFailure}
                    />
                  ) : projectPane === "kubernetes" && canShareEnv && envDek && selectedEnv ? (
                    <KubernetesLinks
                      session={session}
                      projectName={selected}
                      environmentName={selectedEnv}
                      envDek={envDek}
                      keyVersion={environments.find((e) => e.name === selectedEnv)?.keyVersion ?? 0}
                      canShare={canShareEnv}
                      onStatus={setStatus}
                      onAuthFailure={onAuthFailure}
                    />
                  ) : projectPane === "settings" && canManageEnv && isOrg && envDek && selectedEnv ? (
                    <ProjectVisibility
                      session={session}
                      projectName={selected}
                      environmentName={selectedEnv}
                      envDek={envDek}
                      keyVersion={environments.find((e) => e.name === selectedEnv)?.keyVersion ?? 0}
                      members={members}
                      accessList={accessList}
                      myLevel={accessLevel}
                      myCaps={accessCaps}
                      ownerUsername={activeTenant?.ownerUsername}
                      busy={busy}
                      onAccessListChange={setAccessList}
                      onStatus={setStatus}
                      onError={setError}
                      onBusy={setBusy}
                      onAuthFailure={onAuthFailure}
                      onRotated={() => refreshEnvironments(selected, selectedEnv ?? undefined)}
                    />
                  ) : environments.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center py-16 text-center">
                      <p className="text-sm text-muted-foreground">
                        No environments available for this project.
                      </p>
                    </div>
                  ) : (
                    <>
                      {canWrite && importOpen && (
                        <div className="mb-4 space-y-3 rounded-xl border bg-card p-4 shadow-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium" title="Groups: `# @group name` lines in .env, or a nested object per group in JSON">Paste .env or JSON</p>
                            {detectedPreview?.format && !detectedPreview.error ? (
                              <Badge variant="success">
                                Detected {detectedPreview.format === "json" ? "JSON" : ".env"} ·{" "}
                                {detectedPreview.count} keys
                                {detectedPreview.groups > 0 ? ` · ${detectedPreview.groups} group${detectedPreview.groups === 1 ? "" : "s"}` : ""}
                              </Badge>
                            ) : detectedPreview?.error ? (
                              <Badge variant="destructive">{detectedPreview.error}</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Auto-detects format as you paste
                              </span>
                            )}
                          </div>
                          <Textarea
                            value={importText}
                            onChange={(e) => setImportText(e.target.value)}
                            spellCheck={false}
                            className="font-mono text-xs"
                            rows={8}
                          />
                          {importHint && (
                            <Alert variant="destructive">
                              <AlertDescription>{importHint}</AlertDescription>
                            </Alert>
                          )}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={!importText.trim()}
                              onClick={() => applyImport("merge")}
                            >
                              Merge import
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!importText.trim()}
                              onClick={() => applyImport("replace")}
                            >
                              Replace all
                            </Button>
                          </div>
                        </div>
                      )}

                      {groupsOpen && (
                        <GroupRegistry labels={labels} inUse={groupsInUse} canWrite={canWrite} onChange={(next) => { setLabels(next); setStatus(null); }} />
                      )}
                      {groupTabs.length > 1 && (
                        <div className="mb-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Show keys in a group">
                          {[{ group: "", keys: rows.length }, ...groupTabs].map((t) => (
                            <button
                              key={t.group || "all"}
                              type="button"
                              role="tab"
                              aria-selected={activeFilter === t.group}
                              onClick={() => setGroupFilter(t.group)}
                              className={cn(
                                "rounded-full border px-3 py-1 font-mono text-xs transition-colors",
                                activeFilter === t.group
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "bg-card text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {t.group || "all"} <span className="opacity-70">{t.keys}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
                        <div className="hidden grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_7rem_auto] gap-2 border-b bg-muted/50 px-4 py-2.5 sm:grid text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <span>Key</span>
                          <span>Value</span>
                          <span title="Which Secret or ConfigMap a Kubernetes link puts this key in">Group</span>
                          <span className="w-24 text-right">
                            {activeFilter ? `${visibleRows.length} of ${rows.length}` : `${rows.length} total`}
                          </span>
                        </div>
                        {rows.length === 0 ? (
                          <div className="px-4 py-12 text-center">
                            <div className="mx-auto grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                              <KeyRound className="size-5" />
                            </div>
                            <p className="mt-3 text-sm font-medium">No keys yet</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {canWrite
                                ? "Add a key, or paste a .env file with Import."
                                : "This environment has no keys."}
                            </p>
                          </div>
                        ) : visibleRows.length === 0 ? (
                          <p className="px-4 py-10 text-center text-sm text-muted-foreground">No keys in “{activeFilter}”.</p>
                        ) : (
                          visibleRows.map((row) => (
                            <div
                              key={row.id}
                              className="group grid grid-cols-[1fr_auto] items-center gap-x-2 border-b px-3 py-1 transition-colors last:border-b-0 hover:bg-muted/40 sm:grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_7rem_auto] sm:gap-2"
                            >
                              <Input
                                className="h-9 border-transparent bg-transparent font-mono text-[13px] font-medium shadow-none hover:border-input focus-visible:bg-card"
                                value={row.key}
                                onChange={(e) => updateRow(row.id, { key: e.target.value })}
                                placeholder="KEY"
                                spellCheck={false}
                                readOnly={!canWrite}
                              />
                              <Input
                                className={cn(
                                  "h-9 border-transparent bg-transparent font-mono text-[13px] shadow-none hover:border-input focus-visible:bg-card",
                                  !row.revealed && MASK_WITH_CSS && "[-webkit-text-security:disc]",
                                )}
                                // A masked value is not a password: a real password field turns on macOS secure input
                                // (the lock in the menu bar) whenever it has focus, so mask with CSS where we can.
                                type={row.revealed || MASK_WITH_CSS ? "text" : "password"}
                                autoComplete="off"
                                data-1p-ignore
                                data-lpignore="true"
                                value={row.value}
                                onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                placeholder="value"
                                spellCheck={false}
                                readOnly={!canWrite}
                              />
                              <select
                                className="col-span-2 h-9 rounded-md border border-transparent bg-transparent px-2 font-mono text-[12px] text-muted-foreground hover:border-input focus-visible:bg-card focus-visible:text-foreground disabled:opacity-70 sm:col-span-1"
                                value={row.group || "default"}
                                onChange={(e) => updateRow(row.id, { group: e.target.value === "default" ? "" : e.target.value })}
                                aria-label={`Group of ${row.key || "this key"}`}
                                disabled={!canWrite}
                              >
                                <option value="default">default</option>
                                {groupChoices.map((g) => (
                                  <option key={g} value={g}>
                                    {g}
                                  </option>
                                ))}
                              </select>
                              <div className="col-start-2 row-span-2 row-start-1 flex justify-end gap-0.5 opacity-60 sm:col-auto sm:row-auto sm:w-24 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  tooltip={row.revealed ? "Hide value" : "Reveal value"}
                                  onClick={() =>
                                    updateRow(row.id, { revealed: !row.revealed })
                                  }
                                >
                                  {row.revealed ? <EyeOff /> : <Eye />}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  tooltip="Copy value"
                                  onClick={() => {
                                    void navigator.clipboard
                                      ?.writeText(row.value)
                                      .then(() => setStatus("Copied to clipboard"));
                                  }}
                                >
                                  <Copy />
                                </Button>
                                {canWrite && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-8 hover:text-destructive"
                                    tooltip="Remove variable"
                                    onClick={() => removeRow(row.id)}
                                  >
                                    <Trash2 />
                                  </Button>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      </main>

      <Dialog open={envDialogOpen} onOpenChange={setEnvDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New environment</DialogTitle>
            <DialogDescription>
              Creates a new environment with its own encryption key. Keys are wrapped for
              organization admins and the owner (same as new projects).
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor="new-env-name">Name</Label>
            <Input
              id="new-env-name"
              value={newEnvName}
              onChange={(e) => setNewEnvName(e.target.value)}
              placeholder="staging"
              onKeyDown={(e) => {
                if (e.key === "Enter") void onCreateEnvironment();
              }}
            />
          </div>
          <DialogFooter className="mt-6">
            <Button
              disabled={busy || !newEnvName.trim()}
              onClick={() => void onCreateEnvironment()}
            >
              {busy ? "Creating…" : "Create environment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newRecoveryKey !== null} onOpenChange={(o) => !o && setNewRecoveryKey(null)}>
        <DialogContent>
          {newRecoveryKey && (
            <RecoveryKeyPanel
              recoveryKey={newRecoveryKey}
              username={session.username}
              title="Your new recovery key"
              actionLabel="Done"
              onDone={() => setNewRecoveryKey(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <RecoveryKeyDialog
        open={recoveryDialogOpen}
        onOpenChange={setRecoveryDialogOpen}
        session={session}
        onCreated={setNewRecoveryKey}
        onAuthFailure={onAuthFailure}
      />

      <PasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
        session={session}
        busy={busy}
        setBusy={setBusy}
        onChanged={(next) => {
          onSessionUpdate(next);
          setStatus("Password updated");
        }}
        onAuthFailure={onAuthFailure}
      />
    </div>
  );
}
