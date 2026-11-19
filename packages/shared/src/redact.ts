/**
 * Keeping secrets out of terminals and logs. Anything printed to a console, a log file or an
 * error report should pass through here first: it is cheap, and a leaked token is not.
 */

const MASK = "***";

/** Field names whose value is never printed, in `key=value`, `key: value` and JSON forms. */
const SECRET_KEY =
  "(?:pass(?:word|wd|phrase)?|pepper|secret|token|authorization|api[_-]?key|private[_-]?key|recovery[_-]?key|setup[_-]?token|session|cookie|auth[_-]?(?:key|hash|salt)|dek|wrapped\\w*)";

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // scheme://user:password@host: the password may itself contain "@", so match up to the last one
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]*):[^\s/]*@/gi, `$1$2:${MASK}@`],
  // EnvVault service tokens carry a private key
  [/\bevt_[A-Za-z0-9_-]{8,}/g, `evt_${MASK}`],
  // Authorization: Bearer abc.def
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MASK}`],
  // password=hunter2, "token": "abc", PEPPER: xyz, ENVVAULT_TOKEN=evt_…
  [
    new RegExp(`(\\b[A-Za-z0-9_]*${SECRET_KEY}[A-Za-z0-9_]*["']?\\s*[:=]\\s*["']?(?:(?:Bearer|Basic)\\s+)?)([^\\s"'&,;}\\]]+)`, "gi"),
    `$1${MASK}`,
  ],
];

/** Replace anything that looks like a credential with `***`. Safe to call on any text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement as string);
  return out;
}

/**
 * A database target that is safe to print: scheme, user, host, port, database and `sslmode`.
 * The password and every other query parameter are dropped. File paths pass through.
 */
export function describeDbTarget(target: string): string {
  const raw = target.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw; // a SQLite path, not a URL
  try {
    const url = new URL(raw);
    const user = url.username ? `${decodeURIComponent(url.username)}${url.password ? `:${MASK}` : ""}@` : "";
    const ssl = url.searchParams.get("sslmode");
    return `${url.protocol}//${user}${url.host}${url.pathname}${ssl ? `?sslmode=${ssl}` : ""}`;
  } catch {
    return redactSecrets(raw); // unparsable: mask what we can rather than print it as is
  }
}

/**
 * One line describing an error without what it carries: name, code and message only. No `cause`,
 * request input, driver `detail` or stack, any of which can hold values a user sent.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const tag = typeof code === "string" || typeof code === "number" ? ` [${code}]` : "";
    return redactSecrets(`${err.name}${tag}: ${err.message}`);
  }
  return redactSecrets(typeof err === "string" ? err : "non-error thrown");
}
