import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocument, serialize } from './build';

// pnpm openapi:export — writes api/openapi.json (committed; the UI generates its types from it).
async function main(): Promise<void> {
  const target = join(__dirname, '..', '..', 'openapi.json');
  writeFileSync(target, serialize(await buildDocument()));
  process.stdout.write('Wrote openapi.json\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`openapi:export failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
