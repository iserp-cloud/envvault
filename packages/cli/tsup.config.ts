import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
  // Bundle workspace shared code into the published package.
  noExternal: ["@envvault/shared"],
  // Optional native module (OS keychain); loaded dynamically and may be absent.
  external: ["@napi-rs/keyring"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
