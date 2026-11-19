import { defineConfig } from "tsup";

/**
 * Self-contained hub bundle for containers: everything inlined except native /
 * optional modules, so the runtime image needs only Node and these files.
 * (SQLite support is loaded lazily and needs `better-sqlite3`; the container
 * image targets Postgres.)
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist-hub",
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  shims: true,
  sourcemap: false,
  noExternal: [/.*/],
  external: ["better-sqlite3", "pg-native"],
  // Some bundled dependencies are CommonJS and call require().
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
