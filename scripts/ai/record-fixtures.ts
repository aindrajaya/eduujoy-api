import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ClaudeStructuredGenerator } from '../../src/shared/ai/claude/claude.generator';
import { AiCallError } from '../../src/shared/ai/errors';
import { createGeminiClient, GeminiEmbedder, GeminiStructuredGenerator } from '../../src/shared/ai/gemini/gemini.adapters';

// pnpm ai:record-fixtures — makes a few tiny real calls (well under US$0.01 in total) and saves the
// HTTP exchanges to test/fixtures/ai for the offline contract tests. Never saves headers or keys.

const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'test', 'fixtures', 'ai');

interface Exchange {
  request: { method: string; path: string; body: unknown };
  response: { status: number; contentType: string; body: unknown };
}

function keys(): { anthropic: string; gemini: string } {
  const file = join(ROOT, '.env');
  const local = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const anthropic = process.env['ANTHROPIC_API_KEY'] ?? local['ANTHROPIC_API_KEY'];
  const gemini = process.env['GEMINI_API_KEY'] ?? local['GEMINI_API_KEY'];
  if (!anthropic || !gemini) throw new Error('ANTHROPIC_API_KEY and GEMINI_API_KEY are required');
  return { anthropic, gemini };
}

const captured: Exchange[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const response = await realFetch(input, init);
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  url.searchParams.delete('key');
  const text = await response.clone().text();
  captured.push({
    request: {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    },
    response: { status: response.status, contentType: response.headers.get('content-type') ?? '', body: JSON.parse(text) as unknown },
  });
  return response;
};

function save(name: string): void {
  const exchange = captured.pop();
  if (!exchange) throw new Error(`Nothing captured for ${name}`);
  captured.length = 0;
  const serialized = JSON.stringify(exchange, null, 2);
  const { anthropic, gemini } = keys();
  if (serialized.includes(anthropic) || serialized.includes(gemini)) throw new Error(`Refusing to save ${name}: contains a key`);
  writeFileSync(join(OUT, `${name}.json`), `${serialized}\n`);
  process.stdout.write(`saved ${name} (HTTP ${exchange.response.status})\n`);
}

const topic = z.object({ canonicalName: z.string(), domain: z.enum(['software', 'stem', 'non_technical']) });
const prompt = { name: 'fixture', version: 'v1', text: 'Name the canonical topic for the learner phrase and its domain.' };

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { anthropic, gemini } = keys();
  const claude = new ClaudeStructuredGenerator(new Anthropic({ apiKey: anthropic, fetch: globalThis.fetch }));
  const google = createGeminiClient(gemini);

  for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5'] as const) {
    await claude.generate({ stage: 'fixture', model, prompt, input: 'react hooks', schema: topic, maxTokens: 1024 });
    save(`${model}.structured`);
  }
  try {
    await new GeminiStructuredGenerator(google).generate({
      stage: 'fixture',
      model: 'gemini-3.5-flash-lite',
      prompt,
      input: 'react hooks',
      schema: topic,
      maxTokens: 512,
    });
    save('gemini-3.5-flash-lite.structured');
    await new GeminiEmbedder(google).embed({ stage: 'fixture', texts: ['react hooks', 'linear algebra'], kind: 'document' });
    save('gemini-embedding-2.embed');
  } catch (error) {
    if (!(error instanceof AiCallError) || error.failure !== 'billing') throw error;
    // Keep the synthetic Gemini fixtures until the project has credit again.
    process.stdout.write('skipped Gemini: prepaid credits depleted (HTTP 402)\n');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`ai:record-fixtures failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
  process.exitCode = 1;
});
