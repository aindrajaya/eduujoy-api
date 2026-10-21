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
