import { describeTarget, isProdDatabase } from '../prod-endpoints';

export { describeTarget, PROD_ENDPOINTS } from '../prod-endpoints';

export class ProdTargetRefusedError extends Error {
  override name = 'ProdTargetRefusedError';
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
  const prod = isProdDatabase(url, env['PROD_DATABASE_ENDPOINTS']);
  write(`Target database: ${endpoint} (${region})${prod ? ' [PROD]' : ''}\n`);
  if (prod && !argv.includes('--prod')) {
    throw new ProdTargetRefusedError(`Refusing the prod database ${endpoint}: pass --prod to run against it on purpose`);
  }
}
