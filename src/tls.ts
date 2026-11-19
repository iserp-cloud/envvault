import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";

export type TlsFiles = { cert: string; key: string };

/**
 * Optional built-in https, for a hub reached directly by IP and port with no proxy in front.
 * Browsers run EnvVault's encryption only on https (or localhost) pages. Set both
 * `ENVVAULT_TLS_CERT` and `ENVVAULT_TLS_KEY` to PEM file paths, or neither.
 */
export function tlsFromEnv(env: NodeJS.ProcessEnv = process.env): TlsFiles | null {
  const certPath = env.ENVVAULT_TLS_CERT?.trim();
  const keyPath = env.ENVVAULT_TLS_KEY?.trim();
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error("Set both ENVVAULT_TLS_CERT and ENVVAULT_TLS_KEY (paths to the PEM files), or neither.");
  }
  try {
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new Error(`Cannot read the TLS certificate or key (${code ?? "error"}): check ENVVAULT_TLS_CERT / ENVVAULT_TLS_KEY.`);
  }
}

const TLS_HANDSHAKE_BYTE = 0x16;

/** Where a plain-http request should go instead: the same address over https. */
export function httpsLocation(hostHeader: string | undefined, fallbackHost: string, path: string | undefined): string {
  const host = hostHeader && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(hostHeader) ? hostHeader : fallbackHost;
  const target = path && path.startsWith("/") && !path.startsWith("//") ? path : "/";
  return `https://${host}${target}`;
}

/**
 * One port for both: a TLS handshake goes to the https server, and a plain-http request (someone typing
 * `http://ip:port`) is answered with a redirect to the same address over https. Looks at the first byte only.
 */
export function redirectingFront(https: HttpsServer, fallbackHost: string): NetServer {
  const redirect = createHttpServer((req, res) => {
    res.writeHead(308, { location: httpsLocation(req.headers.host, fallbackHost, req.url), "content-length": "0" });
    res.end();
  });
  return createNetServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy()); // a client that never says anything
    socket.once("data", (first) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(first);
      (first[0] === TLS_HANDSHAKE_BYTE ? https : redirect).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
  });
}
