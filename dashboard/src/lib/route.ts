/**
 * Where you are in the dashboard, kept in the URL hash so a refresh (or a copied link) comes back to the same
 * place: `#/projects/<project>/<environment>/<panel>`, `#/settings` or `#/admin`. The hash never leaves the
 * browser, so project and environment names are not sent anywhere.
 */
export type AppPage = "projects" | "settings" | "admin";
export type ProjectPane = "env" | "settings" | "history" | "kubernetes";

export type Route = { page: AppPage; project: string | null; env: string | null; pane: ProjectPane };

const PANES: ProjectPane[] = ["env", "settings", "history", "kubernetes"];

export function parseRoute(hash: string): Route {
  const route: Route = { page: "projects", project: null, env: null, pane: "env" };
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const decode = (s: string | undefined) => {
    if (!s) return null;
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  if (parts[0] === "settings" || parts[0] === "admin") return { ...route, page: parts[0] };
  if (parts[0] === "projects") {
    route.project = decode(parts[1]);
    route.env = route.project ? decode(parts[2]) : null;
    const pane = parts[3] as ProjectPane | undefined;
    if (route.env && pane && PANES.includes(pane)) route.pane = pane;
  }
  return route;
}

export function formatRoute(r: Route): string {
  if (r.page !== "projects") return `#/${r.page}`;
  if (!r.project) return "#/projects";
  const base = `#/projects/${encodeURIComponent(r.project)}`;
  if (!r.env) return base;
  const env = `${base}/${encodeURIComponent(r.env)}`;
  return r.pane === "env" ? env : `${env}/${r.pane}`;
}
