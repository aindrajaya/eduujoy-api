import { randomUUID } from 'node:crypto';
import { type LoggerOptions } from 'pino';
import { type Env } from '../../config';

export const REDACTED = '[redacted]';

/** Field names whose values must never be logged, at any depth up to four levels. */
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'secret',
  'clientSecret',
  // Lemon Squeezy webhook HMAC (A12): not a secret itself, but kept out of logs with the other credentials.
  'x-signature',
] as const;

function keyPath(prefix: string, key: string): string {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
  return prefix === '' ? segment.replace(/^\./, '') : `${prefix}${segment}`;
}

export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) =>
  ['', '*', '*.*', '*.*.*'].map((prefix) => keyPath(prefix, key)),
);

/** Strips the query string: OAuth codes, states and signed tokens travel there. */
export function sanitizeUrl(url: string | undefined): string {
  if (!url) return '';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w.-]{1,128}$/;

/** Reuses a caller's X-Request-Id when it is short and safe to log, otherwise mints a UUID. */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
}

export function buildPinoOptions(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    base: undefined,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  };
}

interface LoggableRequest {
  route?: { path?: unknown };
  baseUrl?: string;
  user?: { userId?: unknown };
}

/**
 * Extra fields on each request log line (PRD-API §12): the matched route pattern (never raw IDs or
 * query strings) and the signed-in user, which JwtAuthGuard sets before the response is logged.
 */
export function requestLogProps(req: LoggableRequest): { route?: string; userId?: string } {
  const pattern = typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : undefined;
  const userId = typeof req.user?.userId === 'string' ? req.user.userId : undefined;
  return { ...(pattern ? { route: pattern } : {}), ...(userId ? { userId } : {}) };
}

/** Masks a client address to its network: the last IPv4 octet, or all but the first three IPv6 groups. */
export function maskAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const v4 = /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(address);
  if (v4) return `${v4[1] ?? ''}.0/24`;
  if (address.includes(':')) {
    const groups = address.split('::')[0]?.split(':').filter(Boolean).slice(0, 3) ?? [];
    return `${groups.join(':')}::/48`;
  }
  return undefined;
}

interface SerializableRequest {
  method: string;
  url: string;
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  raw?: { ip?: string };
}

const header = (req: SerializableRequest, name: string): string | undefined => {
  const value = req.headers?.[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * The request line in logs: method and URL (no query), plus what tells a browser from a script when
 * reading prod logs (23 Oct 2026, unexplained refresh 403s): a truncated user-agent, the Origin header and
 * the client network (masked; the proxy-corrected address with trust proxy 1). Never cookies or auth headers.
 */
export function serializeRequest(req: SerializableRequest): Record<string, string> {
  const userAgent = header(req, 'user-agent');
  const origin = header(req, 'origin');
  const client = maskAddress(req.raw?.ip ?? req.remoteAddress);
  return {
    method: req.method,
    url: sanitizeUrl(req.url),
    ...(userAgent ? { userAgent: userAgent.slice(0, 160) } : {}),
    ...(origin ? { origin: origin.slice(0, 120) } : {}),
    ...(client ? { client } : {}),
  };
}

