import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Usage: pnpm eval:overlap [--all] [--cases seed/_eval/path-eval-v1.json] [--maps seed/concept-maps]
// Read-only, free (lead, 3 Nov 2026): how much of each eval reference's mustCover a topic's concept map
// already names, at the case's placement and target stages. If the share is high, a judge's coverage
// score on paths built with the maps is mostly circular. Smoke cases by default; --all for Gate B's 90.
// No database, no provider: it reads two JSON trees and prints a table.

const STAGES = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'] as const;
const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'vs', 'versus', 'how', 'what', 'why', 'using', 'use', 'basic', 'basics', 'its', 'their']);

interface EvalCase {
  id: string;
  topic: string;
  smoke?: boolean;
  placement: { stage: (typeof STAGES)[number] };
  reference: { mustCover: string[] };
}

interface ConceptMap {
  stages: { stage: string; concepts: { name: string; aliases?: string[] }[] }[];
}

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s: string): Set<string> {
  return new Set(
    normalise(s)
      .split(' ')
      .filter((t) => t && !STOP.has(t)),
  );
}

/** Same name or alias after normalising. */
export function strictMatch(concept: string, names: string[]): boolean {
  const n = normalise(concept);
  return names.some((x) => normalise(x) === n);
}

/** Lexical only (a floor for semantic overlap): equal, one contains the other (4+ chars), or token Jaccard ≥ 0.5. */
export function fuzzyMatch(concept: string, names: string[]): boolean {
  const n = normalise(concept);
  const t = tokens(concept);
  return names.some((x) => {
    const m = normalise(x);
    if (m === n) return true;
    if (Math.min(m.length, n.length) >= 4 && (m.includes(n) || n.includes(m))) return true;
    const u = tokens(x);
    const shared = [...t].filter((w) => u.has(w)).length;
    return t.size > 0 && u.size > 0 && shared / new Set([...t, ...u]).size >= 0.5;
  });
}

/** The map's concept names and aliases at the case's placement stage and the stage above it. */
export function mapNames(map: ConceptMap, placement: (typeof STAGES)[number]): string[] {
  const target = STAGES[Math.min(STAGES.indexOf(placement) + 1, STAGES.length - 1)];
  return map.stages.filter((s) => s.stage === placement || s.stage === target).flatMap((s) => s.concepts.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function main(): void {
  const root = join(__dirname, '..', '..');
  const file = JSON.parse(readFileSync(resolve(arg('cases', join(root, 'seed', '_eval', 'path-eval-v1.json'))), 'utf8')) as { cases: EvalCase[] };
  const mapsDir = resolve(arg('maps', join(root, 'seed', 'concept-maps')));
  const cases = process.argv.includes('--all') ? file.cases : file.cases.filter((c) => c.smoke);
  let total = 0;
  let strict = 0;
  let fuzzy = 0;
  for (const c of cases) {
    const names = mapNames(JSON.parse(readFileSync(join(mapsDir, `${c.topic}.json`), 'utf8')) as ConceptMap, c.placement.stage);
    const must = c.reference.mustCover;
    const s = must.filter((m) => strictMatch(m, names)).length;
    const f = must.filter((m) => fuzzyMatch(m, names));
    total += must.length;
    strict += s;
    fuzzy += f.length;
    const missing = must.filter((m) => !f.includes(m));
    process.stdout.write(`${c.id} ${c.topic.padEnd(24)} mustCover ${must.length}  strict ${s}  fuzzy ${f.length}  not in map: ${missing.join('; ').slice(0, 110)}\n`);
  }
  const pct = (n: number): string => (total ? `${Math.round((100 * n) / total)}%` : '-');
  process.stdout.write(`\n${cases.length} cases, ${total} mustCover concepts: strict ${strict} (${pct(strict)}), fuzzy ${fuzzy} (${pct(fuzzy)})\n`);
}

if (require.main === module) main();
