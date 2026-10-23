/**
 * Neon endpoints of eduujoy-prod (the Koyeb service's database). CLIs refuse them unless `--prod` is
 * passed (user decision, 23 Oct 2026, after a local `.env` pointed at prod for a morning). Extra ids can
 * be added with PROD_DATABASE_ENDPOINTS (comma-separated), e.g. after a prod branch is recreated.
 */
export const PROD_ENDPOINTS: readonly string[] = ['ep-raspy-recipe-bamuza67'];

export class ProdTargetRefusedError extends Error {
  override name = 'ProdTargetRefusedError';
}

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

/**
 * Prints the target (endpoint and region only) to stderr and refuses a prod endpoint unless `--prod`
 * is in argv. Every CLI that connects goes through it (loadDirectDatabaseUrl).
 */
export function guardTarget(
  url: string,
  options: { argv?: readonly string[]; env?: NodeJS.ProcessEnv; write?: (line: string) => void } = {},
): void {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const { endpoint, region } = describeTarget(url);
  const extra = (env['PROD_DATABASE_ENDPOINTS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const prod = [...PROD_ENDPOINTS, ...extra].includes(endpoint);
  write(`Target database: ${endpoint} (${region})${prod ? ' [PROD]' : ''}\n`);
  if (prod && !argv.includes('--prod')) {
    throw new ProdTargetRefusedError(`Refusing the prod database ${endpoint}: pass --prod to run against it on purpose`);
  }
}
