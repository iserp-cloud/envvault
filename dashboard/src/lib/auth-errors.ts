export function isUnauthorized(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unauthorized|invalid auth token|missing auth token/i.test(message);
}
