import { Logger } from '@nestjs/common';
import { costUsd, MODELS, type Provider } from '../catalog';
import { AiCallError, type AiFailure } from '../errors';
import {
  type CallRecord,
  type Embedder,
  type EmbeddingRequest,
  type EmbeddingResult,
  type StructuredGenerator,
  type StructuredRequest,
  type StructuredResult,
} from '../ports';
import { type LlmCallEntry, type LlmCallRecorder, type LlmCallStatus } from './llm-call.recorder';

const NO_USAGE = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

function statusOf(failure: AiFailure): LlmCallStatus {
  if (failure === 'refused' || failure === 'invalid_output' || failure === 'timeout') return failure;
  return 'error';
}

/** Records every call, successful or not, then returns or rethrows the provider's outcome. */
class Meter {
  private readonly logger = new Logger('AiMetering');

  constructor(
    private readonly recorder: LlmCallRecorder,
    private readonly now: () => number,
    private readonly clock: () => Date,
  ) {}

  async run<R extends { call: CallRecord }>(
    meta: { stage: string; provider: Provider; model: string; promptName: string | null; promptVersion: string | null; jobId: string | null },
    fn: () => Promise<R>,
  ): Promise<R> {
    const started = this.now();
    try {
      const result = await fn();
      await this.write({ ...meta, ...this.fromCall(result.call), status: 'ok', failure: null });
      return result;
    } catch (error) {
      const failure: AiFailure = error instanceof AiCallError ? error.failure : 'server';
      const call = error instanceof AiCallError ? error.call : undefined;
      const usageFields = call
        ? this.fromCall(call)
        : { model: meta.model, usage: NO_USAGE, costUsd: 0, latencyMs: Math.round(this.now() - started) };
      await this.write({ ...meta, ...usageFields, status: statusOf(failure), failure });
      throw error;
    }
  }

  private fromCall(call: CallRecord): Pick<LlmCallEntry, 'model' | 'usage' | 'costUsd' | 'latencyMs'> {
    return {
      model: call.model,
      usage: call.usage,
      costUsd: costUsd(call.model, call.usage, this.clock()),
      latencyMs: call.latencyMs,
    };
  }

  /** Metering must never break the AI call it describes; a failed insert is logged instead. */
  private async write(entry: LlmCallEntry): Promise<void> {
    try {
      await this.recorder.record(entry);
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Failed to record llm_calls row');
    }
  }
}

/** Routes each request to its provider's generator by model, and meters it. */
export class MeteredStructuredGenerator implements StructuredGenerator {
  private readonly meter: Meter;

  constructor(
    private readonly providers: Record<Provider, StructuredGenerator>,
    recorder: LlmCallRecorder,
    now: () => number = () => performance.now(),
    clock: () => Date = () => new Date(),
  ) {
    this.meter = new Meter(recorder, now, clock);
  }

  generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const provider = MODELS[request.model].provider;
    return this.meter.run(
      {
        stage: request.stage,
        provider,
        model: request.model,
        promptName: request.prompt.name,
        promptVersion: request.prompt.version,
        jobId: request.jobId ?? null,
      },
      () => this.providers[provider].generate(request),
    );
  }
}

export class MeteredEmbedder implements Embedder {
  private readonly meter: Meter;

  constructor(
    private readonly inner: Embedder,
    private readonly model: string,
    recorder: LlmCallRecorder,
    now: () => number = () => performance.now(),
    clock: () => Date = () => new Date(),
  ) {
    this.meter = new Meter(recorder, now, clock);
  }

  embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return this.meter.run(
      { stage: request.stage, provider: 'google', model: this.model, promptName: null, promptVersion: null, jobId: request.jobId ?? null },
      () => this.inner.embed(request),
    );
  }
}
