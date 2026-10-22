/** A provider answered with an error status; the URL in the message never includes the API key. */
export class ProviderHttpError extends Error {
  override name = 'ProviderHttpError';
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(`${provider} answered ${status}${reason ? ` (${reason})` : ''}`);
  }
}

export type FetchFn = typeof fetch;

/** GET a JSON API with a timeout joined to the job's abort signal. */
export async function getJson(fetchFn: FetchFn, url: URL, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchFn(url, { headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const text = await response.text();
  try {
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  } catch {
    return { status: response.status, body: null };
  }
}
