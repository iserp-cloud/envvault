/**
 * Guards for deployment config: the committed examples hold placeholders only, the files people
 * really use stay git-ignored, and the ignore rules for credentials never swallow source code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const shipped = ["examples/k8s", "examples/operator", "operator/config"]
  .filter((d) => existsSync(join(root, d)))
  .flatMap((d) => walk(d))
  .filter((f) => /\.ya?ml$/.test(f));

function ignored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: root, stdio: "ignore" });
    return true; // exit 0: ignored
  } catch {
    return false; // exit 1: not ignored
  }
}

describe("shipped Kubernetes examples", () => {
  it("find the example files (so the checks below are not vacuous)", () => {
    assert.ok(shipped.length >= 8, `found ${shipped.join(", ")}`);
    for (const f of ["examples/k8s/deployment.yaml", "operator/config/install.yaml", "examples/operator/envvault-config.yaml"]) {
      assert.ok(shipped.includes(f), `${f} is missing`);
    }
  });

  for (const file of shipped) {
    const text = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";

    it(`${file}: no private addresses, real fingerprints, tokens or keys`, () => {
      // 192.0.2.0/24 (TEST-NET-1) is what the examples use; anything else private is a real node.
      assert.doesNotMatch(text, /(?<![\d.])(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)/, "a private IP");
      const prints = text.match(/([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}/g) ?? [];
      for (const p of prints) assert.equal(p, "AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC", "a real certificate fingerprint");
      assert.doesNotMatch(text, /evt_[A-Za-z0-9_-]{20,}/, "a service token");
      assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/, "a private key");
      assert.doesNotMatch(text, /"auth" *: *"[A-Za-z0-9+/=]{12,}"/, "registry credentials");
    });

    it(`${file}: images come from the generic registry and Secret values are placeholders`, () => {
      for (const m of text.matchAll(/^\s*image:\s*(\S+)/gm)) {
        assert.match(m[1], /^ghcr\.io\/(your-org|iserp-cloud)\//, `image ${m[1]} is not a generic one`);
      }
      for (const m of text.matchAll(/^\s*(DATABASE_URL|ENVVAULT_PEPPER|\.dockerconfigjson|token|password):\s*(.+)$/gm)) {
        assert.match(m[2], /REPLACE|USER|PASSWORD|HOST/, `${file}: ${m[1]} holds something that is not a placeholder`);
      }
    });
  }
});

describe("ignore rules", () => {
  it("keep your real config out of git", () => {
    for (const f of [
      "deploy/k8s/deployment.yaml",
      "deploy/k8s/secret.yaml",
      "deploy/operator/install.yaml",
      "examples/k8s/secret.yaml",
      "examples/k8s/docker-pull-secret.yaml",
      "operator/config/docker-pull-secret.yaml",
      "operator/config/config-map.yaml",
      "operator/config/install.local.yaml",
    ]) {
      assert.ok(ignored(f), `${f} would be committed`);
    }
  });

  it("let the examples and the generic install through", () => {
    for (const f of [
      "examples/k8s/deployment.yaml",
      "examples/k8s/secret.example.yaml",
      "examples/k8s/docker-pull-secret.example.yaml",
      "operator/config/install.yaml",
      "examples/operator/envvault-config.yaml",
      "examples/operator/docker-pull-secret.example.yaml",
    ]) {
      assert.ok(!ignored(f), `${f} is ignored, so the example would not ship`);
    }
  });

  it("never swallow source code (the `secrets.*` rule once hid operator/internal/controller/secrets.go)", () => {
    const hidden = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "operator", "src", "packages", "dashboard/src", "test", "scripts"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(go|ts|tsx|mjs|sh|json|ya?ml|md)$/.test(f) && !/node_modules|\/dist\/|\/bin\//.test(f));
    assert.deepEqual(hidden, [], "ignored source files");
  });
});
