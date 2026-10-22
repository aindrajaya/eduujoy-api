import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSeed, readSeedFiles } from '../../src/shared/db/seed/seed-data';
import { flagTopic, type SeedItem } from './flags';
import { SEED_DIR, writeJson } from './ledger';
import { REVIEW_PROMPT_VERSION, VERDICTS_FILE, verdictsFileSchema } from './review';

// seed:items-apply. Applies review verdicts (seed/_review/verdicts.json) to seed/items: keep leaves the
// item alone, revise replaces its prompt, option labels and answer key, drop removes it. No API calls.
// Everything is applied in memory and checked with the db:seed parser before any file is written.
// Applied verdict IDs go to seed/_review/applied.json so a rerun never applies one twice. Only verdicts
// from the current review prompt version are applied.

const ITEMS_DIR = join(SEED_DIR, 'items');
const APPLIED_FILE = join(SEED_DIR, '_review', 'applied.json');
const THIN_CELL = 3;

interface ItemsFile {
  version: 1;
  topic: string;
  items: (SeedItem & { reviewed?: boolean })[];
}

export interface ApplyOptions {
  dryRun: boolean;
}

export function runApply(options: ApplyOptions): void {
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  if (!existsSync(VERDICTS_FILE)) throw new Error('No verdicts yet: run seed:items-review first');
  const onFile = verdictsFileSchema.parse(JSON.parse(readFileSync(VERDICTS_FILE, 'utf8')));
  const verdicts = Object.fromEntries(Object.entries(onFile).filter(([, v]) => v.promptVersion === REVIEW_PROMPT_VERSION));
  const older = Object.keys(onFile).length - Object.keys(verdicts).length;
  if (older > 0) write(`Ignoring ${older} verdicts from older review prompts (current: item-review/${REVIEW_PROMPT_VERSION}).`);
  const applied = new Set<string>(existsSync(APPLIED_FILE) ? (JSON.parse(readFileSync(APPLIED_FILE, 'utf8')) as string[]) : []);

  const files = new Map<string, ItemsFile>();
  const load = (topic: string): ItemsFile | undefined => {
    if (!files.has(topic)) {
      const path = join(ITEMS_DIR, `${topic}.json`);
      if (!existsSync(path)) return undefined;
      files.set(topic, JSON.parse(readFileSync(path, 'utf8')) as ItemsFile);
    }
    return files.get(topic);
  };

  const tally = { keep: 0, revise: 0, drop: 0, keyChanged: 0, already: 0, stale: 0 };
  const stale: string[] = [];
  const touched = new Set<string>();
  for (const [id, entry] of Object.entries(verdicts).sort(([a], [b]) => a.localeCompare(b))) {
    if (applied.has(id)) {
      tally.already++;
      continue;
    }
    const [topic = '', key = ''] = id.split('--');
    const file = load(topic);
    const index = file?.items.findIndex((i) => i.key === key) ?? -1;
    const item = file?.items[index];
    const { verdict } = entry;
    if (!file || !item) {
      stale.push(`${id}: item not found`);
      continue;
    }
    if (verdict.verdict === 'keep') {
      tally.keep++;
    } else if (verdict.verdict === 'drop') {
      file.items.splice(index, 1);
      tally.drop++;
      touched.add(topic);
    } else {
      const revised = verdict.revised;
      const ids = (item.options ?? []).map((o) => o.id);
      if (!revised || revised.options.map((o) => o.id).sort().join(',') !== [...ids].sort().join(',')) {
        stale.push(`${id}: revision doesn't match the item's option ids`);
        continue;
      }
      const labels = new Map(revised.options.map((o) => [o.id, o.label.trim()]));
      const newKey = [...revised.correctIds].sort();
      const keyChanged = newKey.join(',') !== [...(item.answerKey?.optionIds ?? [])].sort().join(',');
      file.items[index] = {
        ...item,
        prompt: revised.prompt.trim(),
        options: ids.map((optionId) => ({ id: optionId, label: labels.get(optionId) ?? '' })),
        answerKey: { optionIds: newKey },
        // The rubric explains the old key; drop it rather than ship a wrong explanation.
        ...(keyChanged ? { rubric: undefined } : {}),
      };
      if (keyChanged) tally.keyChanged++;
      tally.revise++;
      touched.add(topic);
    }
    applied.add(id);
  }
  tally.stale = stale.length;

  // Parser check on the whole result before anything is written.
  const raw = readSeedFiles(SEED_DIR);
  for (const [topic, file] of files) raw.items[topic] = JSON.parse(JSON.stringify(file)) as unknown;
  const parsed = parseSeed(raw);

  write(
    `Verdicts: keep ${tally.keep}, revise ${tally.revise} (key changed in ${tally.keyChanged}; their rubrics removed), drop ${tally.drop}; ` +
      `already applied ${tally.already}; skipped as stale ${tally.stale}.`,
  );
  for (const line of stale.slice(0, 10)) write(`  stale: ${line}`);
  write(`Parser check passed: ${parsed.topics.length} topics, ${parsed.items.length} items after applying.`);

  const thin: string[] = [];
  let longest = 0;
  let single = 0;
  for (const topic of touched) {
    const file = files.get(topic);
    if (!file) continue;
    const cells = new Map<string, number>();
    for (const item of file.items) cells.set(`${item.stage} ${item.bloom}`, (cells.get(`${item.stage} ${item.bloom}`) ?? 0) + 1);
    for (const [cell, n] of cells) if (n < THIN_CELL) thin.push(`${topic} ${cell}: ${n}`);
    longest += flagTopic(topic, file.items).filter((f) => f.flags.includes('longest-key')).length;
    single += file.items.filter((i) => (i.answerKey?.optionIds ?? []).length === 1).length;
  }
  if (single > 0) write(`Key is the longest option in ${longest}/${single} single-answer items of the ${touched.size} changed topics (${Math.round((100 * longest) / single)}%).`);
  if (thin.length > 0) write(`Cells left with fewer than ${THIN_CELL} items: ${thin.join('; ')}`);

  if (options.dryRun) {
    write('Dry run: nothing written.');
    return;
  }
  for (const topic of touched) {
    const file = files.get(topic);
    if (file) writeJson(join(ITEMS_DIR, `${topic}.json`), file);
  }
  writeJson(APPLIED_FILE, [...applied].sort());
  write(`Wrote ${touched.size} item files and seed/_review/applied.json.`);
}
