import winston from 'winston';

/**
 * Redact secrets before anything is written. git errors from simple-git carry
 * the full command — including the `http.extraHeader=Authorization: Basic ...`
 * we pass for auth — and API errors can echo keys. Scrub every string field
 * (message, stack, and nested meta like the simple-git task object) so a
 * token never lands in logs.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Authorization:\s*(Basic|Bearer|token)\s+[A-Za-z0-9+/=._-]+/gi, 'Authorization: $1 [REDACTED]'],
  [/x-access-token:[A-Za-z0-9._-]+/gi, 'x-access-token:[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_GH_TOKEN]'],
  [/sk-(ant|proj)-[A-Za-z0-9._-]{20,}/g, '[REDACTED_KEY]'],
  [/ghs_[A-Za-z0-9]{20,}/g, '[REDACTED_GH_TOKEN]'],
];

/**
 * Redact secrets from a string. Exported so anything that surfaces error text
 * to an untrusted destination (e.g. a PR comment) can scrub it first — a git
 * error can carry the auth header, and we must never echo that into a comment.
 */
export function scrubSecrets(s: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, repl]) => acc.replace(re, repl), s);
}

function scrubDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], seen);
    return value;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    (value as Record<string, unknown>)[k] = scrubDeep((value as Record<string, unknown>)[k], seen);
  }
  return value;
}

const redact = winston.format((info) => scrubDeep(info) as winston.Logform.TransformableInfo)();

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    redact,
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(redact, winston.format.colorize(), winston.format.simple()),
    }),
  ],
});
