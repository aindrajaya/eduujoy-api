import { Writable } from 'node:stream';
import pino from 'pino';
import { buildPinoOptions, REDACTED, requestLogProps, resolveRequestId, sanitizeUrl } from './logger-options';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('buildPinoOptions', () => {
  it('uses the configured level and JSON output in production', () => {
    const options = buildPinoOptions({ LOG_LEVEL: 'warn', NODE_ENV: 'production' });

    expect(options.level).toBe('warn');
    expect(options.transport).toBeUndefined();
  });

  it('redacts credentials in headers and bodies', () => {
    const { stream, lines } = capture();
    const logger = pino(buildPinoOptions({ LOG_LEVEL: 'info', NODE_ENV: 'production' }), stream);

    logger.info({
      req: { headers: { cookie: 'ej_at=abc', authorization: 'Bearer abc', 'user-agent': 'jest', 'x-signature': 'hmac-hex' } },
      res: { headers: { 'set-cookie': ['ej_rt=def'] } },
      body: { email: 'a@b.c', password: 'hunter2', refreshToken: 'r', apiKey: 'k' },
      err: { config: { headers: { 'x-api-key': 'vendor-key' } } },
    });

    const [line] = lines();
    expect(line).toMatchObject({
      req: { headers: { cookie: REDACTED, authorization: REDACTED, 'user-agent': 'jest', 'x-signature': REDACTED } },
      res: { headers: { 'set-cookie': REDACTED } },
      body: { email: 'a@b.c', password: REDACTED, refreshToken: REDACTED, apiKey: REDACTED },
      err: { config: { headers: { 'x-api-key': REDACTED } } },
    });
    expect(JSON.stringify(line)).not.toMatch(/hunter2|vendor-key|ej_at=abc/);
  });
});

describe('sanitizeUrl', () => {
  it('drops the query string so OAuth codes and tokens never reach logs', () => {
    expect(sanitizeUrl('/v1/auth/google/callback?code=secret&state=s')).toBe('/v1/auth/google/callback');
    expect(sanitizeUrl('/health')).toBe('/health');
    expect(sanitizeUrl(undefined)).toBe('');
  });
});

describe('resolveRequestId', () => {
  it('keeps a well-formed incoming id', () => {
    expect(resolveRequestId('abc-123_DEF.9')).toBe('abc-123_DEF.9');
  });

  it('replaces missing, oversized or unsafe ids with a UUID', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    expect(resolveRequestId(undefined)).toMatch(uuid);
    expect(resolveRequestId('a'.repeat(129))).toMatch(uuid);
    expect(resolveRequestId('bad\nid')).toMatch(uuid);
    expect(resolveRequestId(['x', 'y'])).toMatch(uuid);
  });
});

describe('requestLogProps', () => {
  it('logs the route pattern and the signed-in user', () => {
    expect(requestLogProps({ route: { path: '/v1/paths/:id' }, user: { userId: 'u-1' } })).toEqual({
      route: '/v1/paths/:id',
      userId: 'u-1',
    });
  });

  it('omits both for unmatched routes and anonymous requests', () => {
    expect(requestLogProps({})).toEqual({});
  });
});

