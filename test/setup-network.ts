// Every Jest run (unit, integration, e2e): tests never reach the internet. Local servers (AI fixture
// servers, the app under test) are fine; anything else fails loudly instead of calling a real API.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const realFetch = globalThis.fetch.bind(globalThis);

export class BlockedNetworkError extends Error {
  override name = 'BlockedNetworkError';
}

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    return Promise.reject(new BlockedNetworkError(`Outbound request blocked in tests: ${url.hostname} (fake the adapter instead)`));
  }
  return realFetch(input, init);
};
