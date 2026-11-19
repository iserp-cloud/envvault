/**
 * Key rotation re-encrypts the current value and every saved version, and sends them in ONE request,
 * which the hub caps at 4 MiB. A long history of large environments can exceed that, and a rotation
 * that fails on size would leave a removed member's old key working. So the client keeps the
 * newest versions that fit and drops the rest; the current value and the new keys always go through.
 */

/** The hub rejects request bodies larger than this (`MAX_BODY_BYTES` on the server). */
export const REQUEST_LIMIT_BYTES = 4 * 1024 * 1024;
/** Left free for the request envelope and anything the estimate misses. */
const HEADROOM_BYTES = 256 * 1024;
/** The most versions the hub accepts in one rotation. */
const MAX_HISTORY = 100;

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Choose which re-encrypted versions to send. `request` is the rotation request without its history
 * (current payload and key wraps). Newest versions are kept first. Throws if even the request on its
 * own is too large, since that rotation can't be sent at all.
 */
export function fitHistory<T extends { version: number }>(
  request: unknown,
  versions: T[],
  limit: number = REQUEST_LIMIT_BYTES - HEADROOM_BYTES,
): { kept: T[]; dropped: T[] } {
  let used = bytes(request);
  if (used > limit) throw new Error("This environment is too large to re-key in one request.");
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const v of [...versions].sort((a, b) => b.version - a.version)) {
    const cost = bytes(v) + 1; // +1 for the separating comma
    if (kept.length < MAX_HISTORY && used + cost <= limit) {
      kept.push(v);
      used += cost;
    } else {
      dropped.push(v);
    }
  }
  return { kept, dropped };
}
