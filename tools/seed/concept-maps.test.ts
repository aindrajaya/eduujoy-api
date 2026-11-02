import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ALLOWED_INPUTS, checkMap, draftRequest, inputReads, inPrerequisiteOrder, loadTopics, readInput, type ConceptMap } from './concept-maps';

// Run with `pnpm seed:test`. Isolation (user and lead, 3 Nov 2026): the concept-map generator reads only
// topics.json and its own prompts, and never loads the eval set, the eval tools or their prompts.

/** Relative imports reachable from a tools/seed entry file, following tools/seed and src/ sources. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
      const spec = match[1] ?? '';
      const target = resolve(dirname(file), spec);
      const asFile = target.endsWith('.ts') ? target : `${target}.ts`;
      visit(existsSync(asFile) ? asFile : join(target, 'index.ts'));
    }
  };
  visit(entry);
  return seen;
}

void describe('concept-maps isolation', () => {
  void it('refuses to read the eval set, the eval tools or other prompts', () => {
    for (const path of ['seed/_eval/path-eval-v1.json', 'seed/_eval/topic-resolve-holdout-v2.json', 'tools/seed/path-eval.ts', 'src/prompts/path-eval-draft/v1.md', 'seed/items/python.json']) {
      assert.throws(() => readInput(path), /may not read/);
    }
  });

  void it('reads only its allow-list while building every request', () => {
    inputReads.clear();
    const topics = loadTopics();
    const prompt = readInput('src/prompts/concept-map/v1.md');
    readInput('src/prompts/concept-map-review/v1.md');
    for (const topic of topics) draftRequest(topic, topics, prompt);
    assert.ok([...inputReads].every((p) => (ALLOWED_INPUTS as readonly string[]).includes(p)));
    assert.deepEqual([...inputReads].sort(), [...ALLOWED_INPUTS].sort());
  });

  void it('never loads the eval tools or the prompt registry from its entry point', () => {
    const graph = [...importGraph(join(__dirname, 'concept-maps-cli.ts'))].map((f) => f.split('/').slice(-2).join('/'));
    for (const banned of ['seed/path-eval.ts', 'seed/refine.ts', 'seed/items.ts', 'seed/review.ts', 'seed/taxonomy.ts', 'seed/cli.ts', 'prompts/prompt-registry.ts']) {
      assert.ok(!graph.includes(banned), `concept-maps-cli.ts reaches ${banned}`);
    }
    assert.ok(graph.includes('seed/concept-maps.ts') && graph.includes('seed/ledger.ts'), 'the walker follows imports');
    // Control: the shared cli.ts does reach the eval tool, which is why concept maps have their own entry.
    const shared = [...importGraph(join(__dirname, 'cli.ts'))].map((f) => f.split('/').slice(-2).join('/'));
    assert.ok(shared.includes('seed/path-eval.ts') && shared.includes('prompts/prompt-registry.ts'));
  });
});

void describe('checkMap and prerequisite order', () => {
  const topics = loadTopics();
  const topic = topics.find((t) => t.slug === 'git');
  if (!topic) throw new Error('fixture topic git missing');
  const stage = (s: ConceptMap['stages'][number]['stage'], prefix: string, blooms: [string, string]): ConceptMap['stages'][number] => ({
    stage: s,
    concepts: [1, 2, 3, 4].map((n) => ({ id: `${prefix}-${n}`, name: `${s} concept ${String.fromCharCode(96 + n)}`, aliases: [], bloom: (n % 2 ? blooms[0] : blooms[1]) as 'C1', summary: 'A concept summary.' })),
    prerequisites: [[`${prefix}-2`, `${prefix}-1`]],
    misconceptions: [
      { text: 'A misconception about this.', concepts: [`${prefix}-1`] },
      { text: 'Another misconception here.', concepts: [`${prefix}-2`] },
    ],
  });
  const valid = (): ConceptMap => ({
    stages: [stage('novice', 'nov', ['C1', 'C2']), stage('advanced_beginner', 'adb', ['C2', 'C3']), stage('competent', 'cmp', ['C3', 'C4']), stage('proficient', 'prf', ['C4', 'C5']), stage('expert', 'exp', ['C5', 'C6'])],
  });

  void it('accepts a well-formed map', () => {
    assert.deepEqual(checkMap(topic, topics, valid()), []);
  });

  void it('rejects a Bloom level outside the band, a cycle, a repeated name and a stop-listed name', () => {
    const m = valid();
    const nov = m.stages[0];
    if (!nov?.concepts[0] || !nov.concepts[1] || !nov.concepts[2]) throw new Error('fixture');
    nov.concepts[0].bloom = 'C4';
    nov.prerequisites.push(['nov-1', 'nov-2']);
    nov.concepts[1].name = 'advanced_beginner concept a';
    nov.concepts[2].name = 'Overview';
    const problems = checkMap(topic, topics, m).join(' | ');
    assert.match(problems, /outside C1-C2/);
    assert.match(problems, /cycle/);
    assert.match(problems, /repeats/);
    assert.match(problems, /stop-listed/);
  });

  void it('orders a stage by its prerequisites', () => {
    const s = valid().stages[0];
    if (!s) throw new Error('fixture');
    assert.deepEqual(inPrerequisiteOrder(s).map((c) => c.id), ['nov-2', 'nov-1', 'nov-3', 'nov-4']);
  });
});
