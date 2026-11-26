import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("hub shutdown", () => {
  it("exits promptly on SIGTERM (a container's PID 1 otherwise ignores it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "envvault-stop-"));
    const port = 39000 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "serve", "--host", "127.0.0.1", "-p", String(port)], {
      env: { ...process.env, DATABASE_URL: join(dir, "vault.db"), ENVVAULT_SETUP_TOKEN: "stop-test-token" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("hub did not start")), 20_000);
        child.stdout.on("data", (b) => {
          if (String(b).includes("listening on")) {
            clearTimeout(t);
            resolve();
          }
        });
        child.once("exit", () => reject(new Error("hub exited early")));
      });
      const started = Date.now();
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
      assert.equal(code, 0);
      assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started} ms`);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
