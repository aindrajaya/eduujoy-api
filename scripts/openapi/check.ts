import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { CONTRACT_VERSION } from '../../src/shared/common/openapi';
import { buildDocument, serialize } from './build';
import { compareToContract, type OpenApiDoc } from './compare';
import { CONTRACT_EXCEPTIONS } from './exceptions';

// pnpm openapi:check — fails when openapi.json is stale or the API drifts from the frozen contract.
// --fresh-only skips the contract diff (CI checks out api/ alone, without ../docs/contract).
const ROOT = join(__dirname, '..', '..');
const CONTRACT = process.env['OPENAPI_CONTRACT'] ?? join(ROOT, '..', 'docs', 'contract', 'openapi.v0.yaml');

async function main(): Promise<void> {
  const failures: string[] = [];
  const exportedText = serialize(await buildDocument());
  // Compare the JSON form: exactly what is committed and what the UI generates types from.
  const exported = JSON.parse(exportedText) as OpenApiDoc;

  const committedPath = join(ROOT, 'openapi.json');
  const committed = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : '';
  if (committed !== exportedText) failures.push('openapi.json is stale: run `pnpm openapi:export` and commit it');

  if (process.argv.includes('--fresh-only')) {
    report(failures, 'openapi.json is up to date (contract diff skipped: --fresh-only)');
    return;
  }

  if (!existsSync(CONTRACT)) throw new Error(`Contract not found at ${CONTRACT} (set OPENAPI_CONTRACT)`);
  const contract = parse(readFileSync(CONTRACT, 'utf8')) as OpenApiDoc & { info?: { version?: string } };
  if (contract.info?.version !== CONTRACT_VERSION) {
    failures.push(
      `contract is ${String(contract.info?.version)} but the API targets ${CONTRACT_VERSION}: review the CHANGELOG, ` +
        'update the API, then bump CONTRACT_VERSION',
    );
  }

  const result = compareToContract(exported, contract, CONTRACT_EXCEPTIONS);
  failures.push(...result.errors);
  const implemented = Object.values(exported.paths ?? {}).reduce((n, item) => n + Object.keys(item).length, 0);
  process.stdout.write(
    `Contract ${CONTRACT_VERSION}: ${implemented} operations match; ${result.notImplemented.length} not built yet.\n`,
  );
  for (const line of result.excepted) process.stdout.write(`  excepted: ${line}\n`);
  report(failures, 'openapi:check passed');
}

function report(failures: string[], success: string): void {
  if (failures.length === 0) {
    process.stdout.write(`${success}\n`);
    return;
  }
  process.stderr.write(`openapi:check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`openapi:check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
