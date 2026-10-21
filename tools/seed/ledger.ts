import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { costUsd, SPEND_CAP_USD, usd, type Usage } from './pricing';

// Run bookkeeping under seed/: _state.json keeps open batch IDs so an interrupted run resumes instead
// of paying twice, and _spend.md is the human-readable log of what every paid run actually cost.

export const ROOT = join(__dirname, '..', '..');
export const SEED_DIR = join(ROOT, 'seed');
const STATE_FILE = join(SEED_DIR, '_state.json');
const SPEND_FILE = join(SEED_DIR, '_spend.md');

const runSchema = z.object({ batchId: z.string(), submittedAt: z.string(), requests: z.number().int(), promptVersion: z.string() });
const stateSchema = z.object({ open: z.record(z.string(), runSchema) });
export type OpenRun = z.infer<typeof runSchema>;
type State = z.infer<typeof stateSchema>;

function readState(): State {
  if (!existsSync(STATE_FILE)) return { open: {} };
  return stateSchema.parse(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
}

function writeState(state: State): void {
  writeJson(STATE_FILE, state);
}

export function openRun(command: string): OpenRun | undefined {
  return readState().open[command];
}

export function recordOpenRun(command: string, run: OpenRun): void {
  const state = readState();
  state.open[command] = run;
  writeState(state);
}

export function closeRun(command: string): void {
  const open = Object.fromEntries(Object.entries(readState().open).filter(([key]) => key !== command));
  writeState({ open });
}

const SPEND_HEADER = [
  '# Credit-sprint spend',
  '',
  `Actual cost of every paid run, from API usage at catalog list prices. Hard stop at US$${SPEND_CAP_USD}.`,
  '',
  '| Date (UTC) | Command | Mode | Requests | Input | Cache write | Cache read | Output | US$ | Ref |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '',
].join('\n');

export function totalSpentUsd(): number {
  if (!existsSync(SPEND_FILE)) return 0;
  let total = 0;
  for (const line of readFileSync(SPEND_FILE, 'utf8').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const amount = /^\$(\d+(?:\.\d+)?)$/.exec(cells[9] ?? '');
    if (amount?.[1]) total += Number(amount[1]);
  }
  return total;
}

export function logSpend(entry: { command: string; batch: boolean; requests: number; usage: Usage; ref: string }): number {
  if (!existsSync(SPEND_FILE)) writeText(SPEND_FILE, SPEND_HEADER);
  const cost = costUsd(entry.usage, entry.batch);
  const { input, cacheWrite, cacheRead, output } = entry.usage;
  const row = [
    new Date().toISOString().slice(0, 16).replace('T', ' '),
    entry.command,
    entry.batch ? 'batch' : 'standard',
    entry.requests,
    input,
    cacheWrite,
    cacheRead,
    output,
    `$${cost.toFixed(4)}`,
    entry.ref,
  ];
  appendFileSync(SPEND_FILE, `| ${row.join(' | ')} |\n`);
  return cost;
}

/** Refuses a run whose worst-case estimate would take total spend past the cap. */
export function assertWithinCap(estimateUsd: number): void {
  const spent = totalSpentUsd();
  if (spent + estimateUsd > SPEND_CAP_USD) {
    throw new Error(`Spend cap: ${usd(spent)} spent + ${usd(estimateUsd)} estimated exceeds US$${SPEND_CAP_USD}`);
  }
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Rejected rows go to seed/_rejects/<command>.jsonl with the reason, newest last. */
export function reject(command: string, id: string, reason: string, raw?: unknown): void {
  const path = join(SEED_DIR, '_rejects', `${command}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), id, reason, raw })}\n`);
}
