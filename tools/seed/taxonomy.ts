import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toStructuredSchema } from '../../src/shared/ai/json-schema';
import { PromptRegistry } from '../../src/shared/ai/prompts/prompt-registry';
import { type SeedTopic } from '../../src/shared/db/seed/seed-data';
import {
  assertWithinCap,
  closeRun,
  logSpend,
  openRun,
  recordOpenRun,
  reject,
  ROOT,
  SEED_DIR,
  writeJson,
} from './ledger';
import { addUsage, estimate, estimateTokens, formatEstimate, fromApiUsage, SEED_MODEL, usd, ZERO_USAGE, type Usage } from './pricing';

// seed:taxonomy. Input: seed/_taxonomy-proposal.json (slug, name, domain, parent; reviewed by a human).
// Claude adds aliases, a description and prerequisite edges per topic; the result is seed/topics.json in
// seed format v1 (docs/seed-format.md). Accepted answers are cached in seed/_work so a rerun only pays
// for topics that are still missing.

const COMMAND = 'taxonomy';
const PROPOSAL_FILE = join(SEED_DIR, '_taxonomy-proposal.json');
const ANSWERS_FILE = join(SEED_DIR, '_work', 'taxonomy.answers.json');
const TOPICS_FILE = join(SEED_DIR, 'topics.json');
const SAMPLES_FILE = join(SEED_DIR, '_samples', 'taxonomy.json');
const PROMPT = new PromptRegistry(join(ROOT, 'src', 'prompts')).get('taxonomy', 'v1');

const MAX_TOKENS = 8_000;
const EXPECTED_OUTPUT_TOKENS = 2_000;
const POLL_MS = 30_000;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64);
const proposalSchema = z.object({
  version: z.literal(1),
  topics: z.array(
    z.object({ slug, canonicalName: z.string().min(1).max(120), domain: z.enum(['software', 'stem', 'non_technical']), parent: slug.nullable() }),
  ),
});
type ProposedTopic = z.infer<typeof proposalSchema>['topics'][number];

const answerShape = z.object({
  aliases: z.array(z.string().trim().min(1).max(120)).max(10),
  description: z.string().trim().min(1).max(500),
  prerequisites: z.array(z.string()).max(6),
});
type Answer = z.infer<typeof answerShape>;

/** The reply schema, with prerequisites limited to catalog slugs. */
function answerSchema(slugs: [string, ...string[]]): z.ZodType<Answer> {
  return answerShape.extend({ prerequisites: z.array(z.enum(slugs)).max(6) });
}

const answersFileSchema = z.record(z.string(), z.object({ promptVersion: z.string(), answer: z.unknown() }));

export interface TaxonomyOptions {
  dryRun: boolean;
  go: boolean;
  sample?: number;
}

function loadProposal(): ProposedTopic[] {
  return proposalSchema.parse(JSON.parse(readFileSync(PROPOSAL_FILE, 'utf8'))).topics;
}

function loadAnswers(): Map<string, Answer> {
  const answers = new Map<string, Answer>();
  if (!existsSync(ANSWERS_FILE)) return answers;
  for (const [key, entry] of Object.entries(answersFileSchema.parse(JSON.parse(readFileSync(ANSWERS_FILE, 'utf8'))))) {
    if (entry.promptVersion === PROMPT.version) answers.set(key, entry.answer as Answer);
  }
  return answers;
}

function saveAnswers(answers: Map<string, Answer>): void {
  const out: Record<string, { promptVersion: string; answer: Answer }> = {};
  for (const [key, answer] of [...answers].sort(([a], [b]) => a.localeCompare(b))) out[key] = { promptVersion: PROMPT.version, answer };
  writeJson(ANSWERS_FILE, out);
}

function catalogText(topics: ProposedTopic[]): string {
  const lines = topics.map((t) => `${t.slug} | ${t.canonicalName} | ${t.domain} | ${t.parent ?? '-'}`);
  return `<catalog>\nslug | name | domain | parent\n${lines.join('\n')}\n</catalog>`;
}

function userTurn(topic: ProposedTopic): string {
  return `Topic: ${topic.slug} (${topic.canonicalName})`;
}

function requestParams(topics: ProposedTopic[], topic: ProposedTopic): Anthropic.MessageCreateParamsNonStreaming {
  const slugs = topics.map((t) => t.slug) as [string, ...string[]];
  // Length bounds stay out of the API schema (structured outputs reject most of them); Zod enforces them on the reply.
  const apiSchema = z.object({ aliases: z.array(z.string()), description: z.string(), prerequisites: z.array(z.enum(slugs)) });
  return {
    model: SEED_MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: 'text', text: PROMPT.text },
      { type: 'text', text: catalogText(topics), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userTurn(topic) }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(apiSchema) }, effort: 'medium' },
  };
}

/** Parses one reply; on failure writes a reject row and returns undefined. */
function acceptReply(topics: ProposedTopic[], topicSlug: string, message: Anthropic.Message): Answer | undefined {
  if (message.stop_reason !== 'end_turn') {
    reject(COMMAND, topicSlug, `stop_reason ${String(message.stop_reason)}`);
    return undefined;
  }
  const text = message.content.find((block) => block.type === 'text')?.text ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    reject(COMMAND, topicSlug, 'reply is not JSON', text);
    return undefined;
  }
  const parsed = answerSchema(topics.map((t) => t.slug) as [string, ...string[]]).safeParse(json);
  if (!parsed.success) {
    reject(COMMAND, topicSlug, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), json);
    return undefined;
  }
  return parsed.data;
}

function estimateFor(topics: ProposedTopic[], pending: ProposedTopic[], batch: boolean): ReturnType<typeof estimate> {
  const prefixTokens = estimateTokens(PROMPT.text) + estimateTokens(catalogText(topics)) + 600; // + output schema with the slug enum
  const suffixTokens = Math.max(...pending.map((t) => estimateTokens(userTurn(t)))) + 10;
  return estimate(pending.length, { prefixTokens, suffixTokens, outputTokens: EXPECTED_OUTPUT_TOKENS }, batch);
}

/** Round-robin across domains so a small sample covers all three. */
function spread(topics: ProposedTopic[], n: number): ProposedTopic[] {
  const byDomain = ['software', 'stem', 'non_technical'].map((d) => topics.filter((t) => t.domain === d));
  const out: ProposedTopic[] = [];
  for (let i = 0; out.length < n && byDomain.some((list) => i < list.length); i++) {
    for (const list of byDomain) {
      const topic = list[i];
      if (topic && out.length < n) out.push(topic);
    }
  }
  return out;
}

export async function runTaxonomy(options: TaxonomyOptions): Promise<void> {
  const topics = loadProposal();
  const answers = loadAnswers();
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);

  const open = openRun(COMMAND);
  if (open) {
    if (options.dryRun) {
      write(`Batch ${open.batchId} (${open.requests} requests) is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collectBatch(topics, answers, open.batchId);
    assemble(topics, answers);
    return;
  }

  const pending = topics.filter((t) => !answers.has(t.slug));
  write(`Taxonomy: ${topics.length} topics in the proposal, ${answers.size} answered (prompt ${PROMPT.name}/${PROMPT.version}), ${pending.length} pending.`);
  if (pending.length === 0) {
    assemble(topics, answers);
    return;
  }

  const targets = options.sample === undefined ? pending : spread(pending, options.sample);
  const batch = options.sample === undefined;
  const est = estimateFor(topics, targets, batch);
  write(formatEstimate(options.sample === undefined ? 'seed:taxonomy' : `seed:taxonomy --sample ${options.sample}`, est, batch));
  if (options.dryRun) return;
  if (!options.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);

  const client = new Anthropic();
  if (batch) {
    await submitBatch(client, topics, targets);
  } else {
    await runSample(client, topics, targets, answers);
    return;
  }
  const submitted = openRun(COMMAND);
  if (submitted) await collectBatch(topics, answers, submitted.batchId, client);
  assemble(topics, answers);
}

async function runSample(client: Anthropic, topics: ProposedTopic[], targets: ProposedTopic[], answers: Map<string, Answer>): Promise<void> {
  let usage: Usage = ZERO_USAGE;
  const samples: Record<string, Answer> = {};
  try {
    for (const topic of targets) {
      const message = await client.messages.create(requestParams(topics, topic), { timeout: 90_000, maxRetries: 2 });
      usage = addUsage(usage, fromApiUsage(message.usage));
      const answer = acceptReply(topics, topic.slug, message);
      if (answer) {
        samples[topic.slug] = answer;
        answers.set(topic.slug, answer);
      }
    }
  } finally {
    const cost = logSpend({ command: `${COMMAND} --sample`, batch: false, requests: targets.length, usage, ref: PROMPT.version });
    saveAnswers(answers);
    writeJson(SAMPLES_FILE, samples);
    process.stdout.write(`Sample done: ${Object.keys(samples).length}/${targets.length} accepted, actual cost ${usd(cost)}. See seed/_samples/taxonomy.json.\n`);
  }
}

async function submitBatch(client: Anthropic, topics: ProposedTopic[], targets: ProposedTopic[]): Promise<void> {
  const created = await client.messages.batches.create({
    requests: targets.map((topic) => ({ custom_id: topic.slug, params: requestParams(topics, topic) })),
  });
  recordOpenRun(COMMAND, { batchId: created.id, submittedAt: new Date().toISOString(), requests: targets.length, promptVersion: PROMPT.version });
  process.stdout.write(`Submitted batch ${created.id} (${targets.length} requests). Safe to interrupt: rerun to resume.\n`);
}

async function collectBatch(topics: ProposedTopic[], answers: Map<string, Answer>, batchId: string, client = new Anthropic()): Promise<void> {
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === 'ended') break;
    const c = batch.request_counts;
    process.stdout.write(`Batch ${batchId}: ${batch.processing_status}, ${c.processing} processing, ${c.succeeded} succeeded, ${c.errored} errored\n`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  let usage: Usage = ZERO_USAGE;
  let requests = 0;
  let accepted = 0;
  for await (const row of await client.messages.batches.results(batchId)) {
    requests++;
    if (row.result.type !== 'succeeded') {
      reject(COMMAND, row.custom_id, `batch result ${row.result.type}`, row.result.type === 'errored' ? row.result.error : undefined);
      continue;
    }
    usage = addUsage(usage, fromApiUsage(row.result.message.usage));
    const answer = acceptReply(topics, row.custom_id, row.result.message);
    if (answer) {
      answers.set(row.custom_id, answer);
      accepted++;
    }
  }
  saveAnswers(answers);
  const cost = logSpend({ command: COMMAND, batch: true, requests, usage, ref: batchId });
  closeRun(COMMAND);
  process.stdout.write(`Collected batch ${batchId}: ${accepted}/${requests} accepted, actual cost ${usd(cost)}.\n`);
}

/** Builds seed/topics.json once every proposed topic has an answer; otherwise reports what is missing. */
function assemble(topics: ProposedTopic[], answers: Map<string, Answer>): void {
  const missing = topics.filter((t) => !answers.has(t.slug)).map((t) => t.slug);
  if (missing.length > 0) {
    process.stdout.write(`topics.json not written: ${missing.length} topics still need an answer (${missing.join(', ')}). Rerun to retry them.\n`);
    return;
  }

  const out: SeedTopic[] = topics.map((t) => {
    const answer = answers.get(t.slug) as Answer;
    return {
      slug: t.slug,
      canonicalName: t.canonicalName,
      aliases: cleanAliases(t, answer.aliases),
      description: answer.description,
      domain: t.domain,
      parent: t.parent,
      prerequisites: [...new Set(answer.prerequisites)].filter((p) => p !== t.slug && !isDescendant(topics, p, t.slug)),
    };
  });
  for (const [from, to] of breakCycles(out)) reject(COMMAND, from, `dropped prerequisite ${to}: it closes a cycle`);
  writeJson(TOPICS_FILE, { version: 1, topics: out });
  const edges = out.reduce((n, t) => n + t.prerequisites.length, 0);
  process.stdout.write(`Wrote seed/topics.json: ${out.length} topics, ${edges} prerequisite edges. Next: pnpm seed:validate --expect-topics ${out.length}\n`);
}

function cleanAliases(topic: ProposedTopic, aliases: string[]): string[] {
  const seen = new Set([topic.canonicalName.toLowerCase()]);
  return aliases.filter((alias) => {
    const key = alias.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True when `candidate` sits under `ancestor` in the parent tree (a subtopic can't be a prerequisite). */
function isDescendant(topics: ProposedTopic[], candidate: string, ancestor: string): boolean {
  const parents = new Map(topics.map((t) => [t.slug, t.parent]));
  for (let node = parents.get(candidate); node; node = parents.get(node)) if (node === ancestor) return true;
  return false;
}

/** Removes the edge that closes each prerequisite cycle (depth-first, in file order); returns the dropped edges. */
function breakCycles(topics: SeedTopic[]): [string, string][] {
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const dropped: [string, string][] = [];
  const visit = (node: string): void => {
    state.set(node, 'visiting');
    const topic = bySlug.get(node);
    if (topic) {
      for (const next of [...topic.prerequisites]) {
        if (state.get(next) === 'visiting') {
          topic.prerequisites = topic.prerequisites.filter((p) => p !== next);
          dropped.push([node, next]);
        } else if (!state.has(next)) {
          visit(next);
        }
      }
    }
    state.set(node, 'done');
  };
  for (const t of topics) if (!state.has(t.slug)) visit(t.slug);
  return dropped;
}
