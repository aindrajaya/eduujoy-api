import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../../db';
import { llmCalls } from '../../db/schema/ai';
import { type Provider, type TokenUsage } from '../catalog';

export const LLM_CALL_RECORDER = Symbol('LlmCallRecorder');

export type LlmCallStatus = 'ok' | 'error' | 'timeout' | 'invalid_output' | 'refused';

export interface LlmCallEntry {
  stage: string;
  provider: Provider;
  model: string;
  promptName: string | null;
  promptVersion: string | null;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  status: LlmCallStatus;
  failure: string | null;
  jobId: string | null;
}

export interface LlmCallRecorder {
  record(entry: LlmCallEntry): Promise<void>;
}

/** One llm_calls row per model call; feeds the cost and latency dashboards (FR-25). */
@Injectable()
export class DrizzleLlmCallRecorder implements LlmCallRecorder {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(entry: LlmCallEntry): Promise<void> {
    await this.db.insert(llmCalls).values({
      stage: entry.stage,
      provider: entry.provider,
      model: entry.model,
      promptName: entry.promptName,
      promptVersion: entry.promptVersion,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheWriteTokens: entry.usage.cacheWriteTokens,
      costUsd: entry.costUsd.toFixed(6),
      latencyMs: entry.latencyMs,
      status: entry.status,
      failure: entry.failure,
      jobId: entry.jobId,
    });
  }
}
