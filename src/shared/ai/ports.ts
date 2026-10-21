import { type ZodType } from 'zod';
import { type ModelId, type Provider, type TokenUsage } from './catalog';

export const STRUCTURED_GENERATOR = Symbol('StructuredGenerator');
export const EMBEDDER = Symbol('Embedder');

export interface PromptRef {
  name: string;
  version: string;
  /** System prompt text; stable across calls so the provider can cache it. */
  text: string;
}

export interface StructuredRequest<T> {
  /** Pipeline stage for metering and dashboards, e.g. `design`, `grade`, `analyse`. */
  stage: string;
  model: ModelId;
  prompt: PromptRef;
  /** The user turn. Wrap untrusted content with wrapUntrusted() before passing it. */
  input: string;
  /** Every AI output is parsed with Zod; a parse failure is an `invalid_output` error. */
  schema: ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  jobId?: string;
}

export interface CallPart {
  model: string;
  usage: TokenUsage;
}

export interface CallRecord {
  provider: Provider;
  /** The model that actually answered (a server-side fallback can differ from the request). */
  model: string;
  /** Total tokens across every attempt in the call. */
  usage: TokenUsage;
  /**
   * Per-attempt usage when a server-side fallback ran (a refused attempt plus the fallback's). Each
   * part is priced at its own model's rates; absent for single-attempt calls.
   */
  parts?: CallPart[];
  latencyMs: number;
}

export interface StructuredResult<T> {
  output: T;
  call: CallRecord;
}

/** One structured model call (the master PRD's provider-neutral `LLMProvider`). */
export interface StructuredGenerator {
  generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export interface EmbeddingRequest {
  stage: string;
  texts: string[];
  /** Topic phrases are queries; topics and ResourceCards are documents. */
  kind: 'query' | 'document';
  /** Document titles aligned with `texts` (e.g. a topic's canonical name); missing ones become `none`. */
  titles?: (string | null)[];
  jobId?: string;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  /** Bumped when the embedding model or dimensions change, so rows can be re-embedded. */
  version: number;
  call: CallRecord;
}

export interface Embedder {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}
