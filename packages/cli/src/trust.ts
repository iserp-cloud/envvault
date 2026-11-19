import { X509Certificate } from "node:crypto";
import { connect } from "node:tls";

/** What the CLI needs to remember about a certificate it was told to trust. */
export type PeerCert = {
  /** PEM text, which is what gets saved and later added to the trusted list. */
  pem: string;
  /** SHA-256 fingerprint as upper-case hex pairs, e.g. `AA:BB:…` (the form `openssl` and the hub print). */
  fingerprint: string;
  /** Signs itself, so trusting this one certificate is enough. Otherwise it needs its authority. */
  selfSigned: boolean;
};

export function pemOfDer(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** Describe a PEM certificate (throws on something that isn't one). */
export function describeCert(pem: string): PeerCert {
  const x = new X509Certificate(pem);
  return { pem, fingerprint: x.fingerprint256, selfSigned: x.subject === x.issuer && x.verify(x.publicKey) };
}

/** `sha256:aa:bb…`, `AA:BB…` or plain hex all mean the same thing. Null if it isn't a SHA-256 value. */
export function normalizeFingerprint(input: string): string | null {
  const hex = input.trim().replace(/^sha-?256[:=]?/i, "").replace(/[:\s-]/g, "").toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/.{2}/g)!.join(":") : null;
}

/**
 * The certificate a hub presents, read without trusting it. Null when the hub can't be reached
 * or isn't speaking TLS.
 */
export function fetchPeerCert(remote: string): Promise<PeerCert | null> {
  const url = new URL(remote);
  if (url.protocol !== "https:") return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = connect(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || 443),
        // an IP address can't be a TLS server name
        servername: /^[\d.:]+$/.test(url.hostname) ? undefined : url.hostname,
        rejectUnauthorized: false,
      },
      () => {
        const raw = socket.getPeerCertificate().raw;
        socket.end();
        resolve(raw ? describeCert(pemOfDer(raw)) : null);
      },
    );
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}
