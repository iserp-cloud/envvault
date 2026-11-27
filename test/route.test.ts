import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRoute, parseRoute } from "../dashboard/src/lib/route.js";

describe("dashboard URL route", () => {
  it("round-trips pages, projects, environments and panels, including awkward names", () => {
    const routes = [
      { page: "projects", project: null, env: null, pane: "env" },
      { page: "projects", project: "shop", env: null, pane: "env" },
      { page: "projects", project: "shop", env: "prod", pane: "env" },
      { page: "projects", project: "my shop/ü", env: "a b#c", pane: "kubernetes" },
      { page: "settings", project: null, env: null, pane: "env" },
      { page: "admin", project: null, env: null, pane: "env" },
    ] as const;
    for (const r of routes) assert.deepEqual(parseRoute(formatRoute(r)), r);
  });

  it("an empty, unknown or broken hash is the projects page", () => {
    const home = { page: "projects", project: null, env: null, pane: "env" };
    for (const h of ["", "#", "#/", "#/nope", "#/projects/%E0%A4%A", "#/projects/p/e/bogus"]) {
      const r = parseRoute(h);
      assert.equal(r.page, "projects", h);
      assert.equal(r.pane, "env", h);
    }
    assert.deepEqual(parseRoute(""), home);
  });
});
