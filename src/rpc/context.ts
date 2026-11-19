import type { IncomingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";
import type { Database as DbSchema } from "../db/schema.js";

export type HeadersLike =
  | Headers
  | IncomingHttpHeaders
  | Record<string, string | string[] | undefined>;

export type AppContext = {
  headers: HeadersLike;
  db: Kysely<DbSchema>;
  /** Socket peer address (Node). Ignored when running behind trusted proxies. */
  remoteAddress?: string;
  /** True on Cloudflare Workers, where `cf-connecting-ip` is set by the edge. */
  trustCloudflare?: boolean;
};

function fromIncoming(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }
  // Fetch Headers polyfill / duck-typing
  if (
    headers &&
    typeof headers === "object" &&
    "get" in headers &&
    typeof (headers as Headers).get === "function"
  ) {
    return (
      (headers as Headers).get(name) ??
      (headers as Headers).get(name.toLowerCase()) ??
      undefined
    );
  }
  return fromIncoming(
    headers as IncomingHttpHeaders | Record<string, string | string[] | undefined>,
    name,
  );
}

export function getBearerToken(headers: HeadersLike): string | undefined {
  const auth = getHeader(headers, "authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  return getHeader(headers, "x-envvault-token")?.trim() || undefined;
}
