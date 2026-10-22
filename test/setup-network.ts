import http from 'node:http';
import https from 'node:https';

// Every Jest run (unit, integration, e2e): tests never reach the internet. Local servers (AI fixture
// servers, the app under test) are fine; anything else fails loudly instead of calling a real API.
// Covered: global fetch (Node's built-in undici) and node:http / node:https request and get, which
// SDKs such as gaxios use. Raw net sockets are left alone: pg needs the Neon test branch.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class BlockedNetworkError extends Error {
  override name = 'BlockedNetworkError';
}

function assertLocal(hostname: string): void {
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new BlockedNetworkError(`Outbound request blocked in tests: ${hostname} (fake the adapter instead)`);
  }
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  try {
    assertLocal(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return realFetch(input, init);
};

/** The target host of an http(s).request/get call: (url[, options][, cb]) or (options[, cb]). */
function targetHost(args: unknown[]): string {
  const [first, second] = args;
  const fromOptions = (o: unknown): string | undefined => {
    if (!o || typeof o !== 'object') return undefined;
    const { hostname, host } = o as { hostname?: unknown; host?: unknown };
    if (typeof hostname === 'string') return hostname;
    if (typeof host === 'string') return host.replace(/:\d+$/, '');
    return undefined;
  };
  if (typeof first === 'string' || first instanceof URL) return fromOptions(second) ?? new URL(first).hostname;
  return fromOptions(first) ?? 'localhost';
}

for (const mod of [http, https] as const) {
  for (const method of ['request', 'get'] as const) {
    const real = mod[method] as (...args: unknown[]) => http.ClientRequest;
    (mod as unknown as Record<string, unknown>)[method] = (...args: unknown[]): http.ClientRequest => {
      assertLocal(targetHost(args));
      return real.apply(mod, args);
    };
  }
}
