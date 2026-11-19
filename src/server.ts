import { logError } from "./log.js";
import { describeDbTarget } from "@envvault/shared";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { X509Certificate } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { CORSPlugin } from "@orpc/server/plugins";
import type { Kysely } from "kysely";
import { loadConfig, resolveDbTarget } from "./config.js";
import { isPostgresTarget, openDb } from "./db/index.js";
import type { Database as DbSchema } from "./db/schema.js";
import { appRouter } from "./rpc/router.js";
import { isVaultInitialized } from "./rpc/runtime.js";
import { pepperPolicy } from "./auth-proof.js";
import { trustedProxyHops } from "./ratelimit.js";
import { ensureSetupToken } from "./setup-token.js";
import { tlsFromEnv } from "./tls.js";
import { sql } from "kysely";
import { bodyLimitViolation, resolveCorsOrigin, securityHeaders } from "./security.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DASHBOARD_DIR = resolvePath(__dirname, "../dashboard/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...securityHeaders("application/json"),
  });
  res.end(JSON.stringify(body));
}

function tryServeDashboard(urlPath: string, res: ServerResponse): boolean {
  if (urlPath.startsWith("/rpc")) {
    return false;
  }

  if (!existsSync(DASHBOARD_DIR)) return false;

  const relative = urlPath === "/" ? "/index.html" : urlPath;
  const candidate = normalize(join(DASHBOARD_DIR, relative));
  if (candidate !== DASHBOARD_DIR && !candidate.startsWith(DASHBOARD_DIR + sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }

  let filePath = candidate;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DASHBOARD_DIR, "index.html");
  }
  if (!existsSync(filePath)) return false;

  const ext = extname(filePath);
  const type = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    ...securityHeaders(type),
  });
  res.end(readFileSync(filePath));
  return true;
}

export type ServeOptions = {
  port?: number;
  host?: string;
  /** SQLite path or postgres:// URL */
  dbTarget?: string;
};

export async function startServer(options: ServeOptions = {}): Promise<void> {
  const config = loadConfig();
  const port = options.port ?? Number(process.env.PORT ?? 3847);
  const host = options.host ?? "127.0.0.1";
  const dbTarget = options.dbTarget ?? resolveDbTarget(config);
  const usePostgres = isPostgresTarget(dbTarget);

  const db: Kysely<DbSchema> = await openDb(dbTarget);
  warnIfInsecureDatabase(dbTarget);
  // Anything reachable beyond this machine counts as production for the pepper requirement.
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  const policy = pepperPolicy(process.env.NODE_ENV === "production" || !loopback);
  if (policy === "refuse") {
    throw new Error(
      "ENVVAULT_PEPPER is not set. Without it, stored login hashes and audit signatures use a public constant. " +
        "Set a long random ENVVAULT_PEPPER (or ENVVAULT_ALLOW_NO_PEPPER=true to accept the risk).",
    );
  }
  if (policy === "warn") {
    console.warn(
      "WARNING: ENVVAULT_PEPPER is not set — login hashes and audit signatures use a public constant. Set it before real use.",
    );
  }
  if (!(await isVaultInitialized(db))) {
    console.log("No accounts yet — open the dashboard to create the first (administrator) account.");
    const generated = await ensureSetupToken(db);
    if (generated) {
      console.log(`Setup token (required to create the first account): ${generated}`);
    } else if (process.env.ENVVAULT_SETUP_TOKEN?.trim()) {
      console.log("A setup token is required to create the first account (ENVVAULT_SETUP_TOKEN).");
    }
  } else {
    await ensureSetupToken(db); // clears any leftover token
  }

  const handler = new RPCHandler(appRouter, {
    plugins: [
      new CORSPlugin({
        origin: (origin, opts) =>
          resolveCorsOrigin(
            origin,
            typeof opts.request.url === "string"
              ? opts.request.url
              : opts.request.url?.href,
          ) ?? undefined,
        allowHeaders: [
          "Authorization",
          "Content-Type",
        ],
      }),
    ],
    interceptors: [
      onError((error) => {
        logError("rpc", error);
      }),
    ],
  });

  const tls = tlsFromEnv();
  const scheme = tls ? "https" : "http";

  let warnedForwarded = false;
  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `${scheme}://${host}:${port}`);

    // A forwarded address with no trusted hops means a proxy is in front but we can't see
    // clients: they all share one IP, so one caller can exhaust everyone's login limit.
    if (!warnedForwarded && req.headers["x-forwarded-for"] && trustedProxyHops() === 0) {
      warnedForwarded = true;
      console.warn(
        "WARNING: requests carry X-Forwarded-For but ENVVAULT_TRUSTED_PROXIES is not set. " +
          "Every client is treated as one address, so rate limits are shared. Set it to the number of proxies in front of the hub.",
      );
    }

    // Liveness / readiness for Docker and Kubernetes probes.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      try {
        if (url.pathname === "/readyz") await sql`select 1`.execute(db);
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 503, { ok: false });
      }
      return;
    }

    // Bound request bodies before they are buffered.
    const tooBig = bodyLimitViolation(
      req.method ?? "GET",
      req.headers["content-length"],
      req.headers["transfer-encoding"],
    );
    if (tooBig) {
      // The client may still be uploading: don't keep the connection open for it.
      res.setHeader("connection", "close");
      sendJson(res, tooBig.status, { error: tooBig.error });
      return;
    }

    const { matched } = await handler.handle(req, res, {
      prefix: "/rpc",
      context: {
        headers: req.headers,
        db,
        remoteAddress: req.socket.remoteAddress,
      },
    });

    if (matched) return;

    if (req.method === "GET" && tryServeDashboard(url.pathname, res)) {
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  };
  const server = tls
    ? createHttpsServer({ ...tls, minVersion: "TLSv1.2" }, onRequest)
    : createHttpServer(onRequest);

  server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`EnvVault hub listening on ${scheme}://${displayHost}:${port}`);
    if (tls) console.log(`TLS certificate fingerprint (SHA-256): ${new X509Certificate(tls.cert).fingerprint256}`);
    console.log(
      `Vault database: ${usePostgres ? "Postgres" : "SQLite"} (${describeDbTarget(dbTarget)})`,
    );
    console.log(`oRPC: ${scheme}://${displayHost}:${port}/rpc`);
    if (existsSync(DASHBOARD_DIR)) {
      console.log(`Dashboard: ${scheme}://${displayHost}:${port}/`);
    } else {
      console.log("Dashboard not built yet. Run: pnpm build:dashboard");
    }
  });
}

/** Remote Postgres without TLS sends credentials and every ciphertext in the clear. */
function warnIfInsecureDatabase(target: string): void {
  if (!isPostgresTarget(target)) return;
  try {
    const url = new URL(target);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    const mode = url.searchParams.get("sslmode");
    if (!local && (!mode || mode === "disable" || mode === "allow" || mode === "prefer")) {
      console.warn(
        "WARNING: DATABASE_URL points at a remote Postgres without TLS. Add ?sslmode=verify-full (or require).",
      );
    }
  } catch {
    /* unparsable URL: the driver will complain */
  }
}
