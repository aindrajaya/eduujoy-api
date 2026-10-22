import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PromptRegistry, STRUCTURED_GENERATOR, type StructuredGenerator, wrapUntrusted } from '../../../shared/ai';
import { type Analysis, type AnalysisInput, type ResourceAnalyzer } from '../application/ports/resource-analyzer';
import { BLOOMS, STAGES } from '../domain';

export const RESOURCE_ANALYSE_PROMPT = 'resource-analyse';

const score = z.number().int().min(0).max(100);
const timestamp = z.string().regex(/^\d{1,3}(:\d{1,2}){1,2}$/).nullable();

/** The analyser's answer (master PRD §8 ResourceCard fields); every AI output is parsed with Zod. */
export const analysisSchema = z.object({
  dreyfusStage: z.enum(STAGES as unknown as [string, ...string[]]),
  bloomLevels: z.array(z.enum(BLOOMS as unknown as [string, ...string[]])).min(1).max(6),
  prerequisites: z.array(z.string().min(1).max(80)).max(6),
  concepts: z.array(z.object({ name: z.string().min(1).max(120), start: timestamp, end: timestamp })).max(10),
  keyTakeaways: z.array(z.string().min(1).max(300)).min(1).max(5),
  whyThis: z.string().min(1).max(300),
  readingMin: z.number().int().min(1).max(600).nullable(),
  language: z.string().regex(/^[a-z]{2}$/),
  quality: z.object({ relevance: score, accuracySignals: score, recency: score, teaching: score }),
  evidence: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
});

const VIDEO_MODEL = 'gemini-3.8-flash';
const TEXT_MODEL = 'gemini-3.5-flash-lite';

/**
 * Gemini analysis (PRD-API §11): videos with gemini-3.8-flash watching the public YouTube URL (streamed),
 * text with gemini-3.5-flash-lite over the page text or abstract. Raw content is never stored.
 */
@Injectable()
export class GeminiResourceAnalyzer implements ResourceAnalyzer {
  readonly promptVersion: string;

  constructor(
    @Inject(STRUCTURED_GENERATOR) private readonly generator: StructuredGenerator,
    private readonly prompts: PromptRegistry,
  ) {
    this.promptVersion = prompts.get(RESOURCE_ANALYSE_PROMPT).version;
  }

  async analyse(input: AnalysisInput): Promise<Analysis> {
    const video = input.kind === 'video';
    const lines = [
      `Topic: ${input.topic.name}`,
      `Resource: ${video ? 'YouTube video' : 'text'}`,
      wrapUntrusted('resource-title', input.title),
      wrapUntrusted('resource-source', input.source),
      `URL: ${input.url}`,
      video && input.durationMin ? `Length: ${input.durationMin} minutes` : '',
      input.content ? wrapUntrusted('resource-content', input.content) : '',
    ].filter(Boolean);
    const model = video ? VIDEO_MODEL : TEXT_MODEL;
    const { output, call } = await this.generator.generate({
      stage: 'analyse',
      model,
      prompt: this.prompts.get(RESOURCE_ANALYSE_PROMPT, this.promptVersion),
      input: lines.join('\n'),
      schema: analysisSchema,
      maxTokens: 4_000,
      ...(video
        ? { media: { youtubeUrl: input.url, ...(input.clip ? { fps: input.clip.fps, ...(input.clip.endSec === null ? {} : { endOffsetSec: input.clip.endSec }) } : {}) } }
        : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.budgetScope ? { budgetScope: input.budgetScope } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { ...(output as Omit<Analysis, 'model' | 'inputTokens'>), model: call.model, inputTokens: call.usage.inputTokens + call.usage.cacheReadTokens };
  }
}
