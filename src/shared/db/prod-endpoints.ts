/**
 * Neon endpoints of eduujoy-prod (the Koyeb service's database), user decision 23 Oct 2026 after a local
 * `.env` pointed at prod for a morning. PROD_DATABASE_ENDPOINTS (comma-separated) adds ids, e.g. after
 * prod's branch is recreated. Used by the CLI target guard, the test-database guard and the app's env
 * validation; standalone so config can use it without depending on the database layer.
 */
export const PROD_ENDPOINTS: readonly string[] = ['ep-raspy-recipe-bamuza67'];

/** The Neon endpoint id and region of a connection string; never the credentials. */
export function describeTarget(url: string): { endpoint: string; region: string } {
  const host = new URL(url).hostname;
  const [first = '', ...rest] = host.split('.');
  // Neon hosts: <endpoint>[-pooler].<region>.aws.neon.tech; anything else is shown as its host.
  const neon = host.endsWith('.neon.tech');
  return {
    endpoint: neon ? first.replace(/-pooler$/, '') : host,
    region: neon ? rest.filter((p) => p !== 'aws' && p !== 'neon' && p !== 'tech').join('.') : 'local',
  };
}

export function prodEndpoints(extra: string | undefined): string[] {
  return [
    ...PROD_ENDPOINTS,
    ...(extra ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

/** True when the URL's endpoint is prod's; an unparseable URL is not prod (its own validation fails it). */
export function isProdDatabase(url: string, extra: string | undefined): boolean {
  try {
    return prodEndpoints(extra).includes(describeTarget(url).endpoint);
  } catch {
    return false;
  }
}
