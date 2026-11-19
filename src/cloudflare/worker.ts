/**
 * Cloudflare Worker — static dashboard + oRPC API (serverless / request-scoped).
 *
 * - Neon serverless Pool per request (WebSocket)
 * - No global runtime / shared DB handle across requests
 * - Close pool when the request finishes
 */
import { logError } from "../log.js";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { Kysely, PostgresDialect, sql, type PostgresPool } from "kysely";
import type { Database as DbSchema } from "../db/schema.js";
import { ensureSchema } from "../db/store.js";
import { appRouter } from "../rpc/router.js";
import { pepperPolicy } from "../auth-proof.js";
import { bodyLimitViolation, resolveCorsOrigin, securityHeaders } from "../security.js";

neonConfig.webSocketConstructor = WebSocket;

function asKyselyPool(pool: Pool): PostgresPool {
  return pool as unknown as PostgresPool;
}

export type Env = {
  ASSETS: Fetcher;
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  ENVVAULT_ALLOW_SIGNUP?: string;
  ENVVAULT_SIGNUP?: string;
  ENVVAULT_PEPPER?: string;
  ENVVAULT_SETUP_TOKEN?: string;
  ENVVAULT_ALLOW_NO_PEPPER?: string;
  ENVVAULT_SESSION_DAYS?: string;
  ENVVAULT_HSTS?: string;
  ENVVAULT_AUDIT_RETENTION_DAYS?: string;
  ENVVAULT_CORS_ORIGINS?: string;
};

const handler = new RPCHandler(appRouter, {
  plugins: [
    new CORSPlugin({
      origin: (origin, opts) =>
        resolveCorsOrigin(
          origin,
          typeof opts.request.url === "string"
            ? opts.request.url
            : String(opts.request.url),
        ) ?? undefined,
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  ],
  interceptors: [
    onError((error) => {
      logError("orpc", error);
    }),
  ],
});

/** Soft cache: only skip ensureSchema DDL within a warm isolate. */
let schemaReady = false;

function resolveConnectionString(env: Env): {
  connectionString: string;
  via: "hyperdrive" | "secret";
} | null {
  const raw =
    env.DATABASE_URL?.trim() ||
    env.HYPERDRIVE?.connectionString?.trim() ||
    "";
  if (!raw) return null;

  const via = env.DATABASE_URL ? "secret" : "hyperdrive";

  try {
    const url = new URL(raw);
    url.searchParams.delete("channel_binding");
    if (!url.searchParams.get("sslmode")) {
      url.searchParams.set("sslmode", "require");
    }
    return { connectionString: url.toString(), via };
  } catch {
    return { connectionString: raw, via };
  }
}

async function openRequestDb(connectionString: string): Promise<{
  db: Kysely<DbSchema>;
  pool: Pool;
}> {
  const pool = new Pool({ connectionString, max: 1 });
  const db = new Kysely<DbSchema>({
    dialect: new PostgresDialect({ pool: asKyselyPool(pool) }),
  });

  if (!schemaReady) {
    await ensureSchema(db);
    schemaReady = true;
  }

  return { db, pool };
}

function errorResponse(fallback: string): Response {
  return Response.json(
    { error: fallback },
    { status: 500, headers: securityHeaders("application/json") },
  );
}

function withSecurityHeaders(response: Response, contentTypeHint?: string): Response {
  const headers = new Headers(response.headers);
  const type = contentTypeHint ?? headers.get("content-type") ?? undefined;
  for (const [k, v] of Object.entries(securityHeaders(type ?? undefined))) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Propagate Worker vars into process.env for security helpers (Workers compat).
    if (env.ENVVAULT_ALLOW_SIGNUP != null) {
      process.env.ENVVAULT_ALLOW_SIGNUP = env.ENVVAULT_ALLOW_SIGNUP;
    }
    for (const key of [
      "ENVVAULT_SIGNUP",
      "ENVVAULT_PEPPER",
      "ENVVAULT_SETUP_TOKEN",
      "ENVVAULT_ALLOW_NO_PEPPER",
      "ENVVAULT_SESSION_DAYS",
      "ENVVAULT_HSTS",
      "ENVVAULT_AUDIT_RETENTION_DAYS",
    ] as const) {
      if (env[key] != null) process.env[key] = env[key];
    }
    if (env.ENVVAULT_CORS_ORIGINS != null) {
      process.env.ENVVAULT_CORS_ORIGINS = env.ENVVAULT_CORS_ORIGINS;
    }

    const url = new URL(request.url);

    // Public and unauthenticated: no database round-trip, no deployment details.
    if (url.pathname === "/health") {
      const configured = resolveConnectionString(env) !== null;
      return Response.json(
        { ok: configured },
        { status: configured ? 200 : 503, headers: securityHeaders("application/json") },
      );
    }

    const resolved = resolveConnectionString(env);
    if (!resolved) {
      console.error("[envvault] No database configured");
      return errorResponse("Database not configured");
    }

    if (!(url.pathname === "/rpc" || url.pathname.startsWith("/rpc/"))) {
      const asset = await env.ASSETS.fetch(request);
      return withSecurityHeaders(asset);
    }

    if (pepperPolicy(true) === "refuse") {
      console.error("[envvault] ENVVAULT_PEPPER is not configured");
      return Response.json(
        { error: "Server misconfigured: ENVVAULT_PEPPER is not set" },
        { status: 503, headers: securityHeaders("application/json") },
      );
    }

    const tooBig = bodyLimitViolation(
      request.method,
      request.headers.get("content-length"),
      request.headers.get("transfer-encoding"),
    );
    if (tooBig) {
      return Response.json(
        { error: tooBig.error },
        { status: tooBig.status, headers: securityHeaders("application/json") },
      );
    }

    let pool: Pool | undefined;
    try {
      const opened = await openRequestDb(resolved.connectionString);
      pool = opened.pool;

      const { matched, response } = await handler.handle(request, {
        prefix: "/rpc",
        context: {
          headers: request.headers,
          db: opened.db,
          trustCloudflare: true,
        },
      });
      if (matched && response) {
        return withSecurityHeaders(response, "application/json");
      }
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: securityHeaders("application/json") },
      );
    } catch (err) {
      logError("envvault", err);
      return errorResponse("Request failed");
    } finally {
      if (pool) ctx.waitUntil(pool.end().catch(() => undefined));
    }
  },
};
