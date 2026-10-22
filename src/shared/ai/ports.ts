import { type ZodType } from 'zod';
import { type ModelId, type Provider, type TokenUsage } from './catalog';

export const STRUCTURED_GENERATOR = Symbol('StructuredGenerator');
export const EMBEDDER = Symbol('Embedder');
export const WEB_SEARCHER = Symbol('WebSearcher');

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
  /** A public YouTube video the model watches with the prompt (Gemini only; master PRD §8). */
  media?: { youtubeUrl: string };
  jobId?: string;
  /** Aborts the provider call (a job's timeout signal). */
  signal?: AbortSignal;
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
  /** Server-side web searches the call ran (billed per search on top of tokens). */
  webSearchRequests?: number;
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

export interface WebSearchRequest {
  stage: string;
  model: ModelId;
  prompt: PromptRef;
  /** The user turn: what to find. Wrap untrusted content with wrapUntrusted() before passing it. */
  input: string;
  /** Hard cap on searches in the call (the tool's `max_uses`). */
  maxUses: number;
  /** Domains the search never returns (content farms); sent as the tool's `blocked_domains`. */
  blockedDomains?: string[];
  maxTokens?: number;
  jobId?: string;
  signal?: AbortSignal;
}

/** One search result as the tool returned it; `encrypted_content` is never kept (PRD-API §11). */
export interface WebSearchHit {
  url: string;
  title: string;
  pageAge: string | null;
}

export interface WebSearchResult<T> {
  /** Every distinct result the searches returned, in order. */
  hits: WebSearchHit[];
  /** The model's final answer, parsed with the request's schema; null when it was missing or invalid. */
  answer: T | null;
  queries: string[];
  call: CallRecord;
}

/** A model call with server-side web search (the master PRD's `WebDiscovery` search step). */
export interface WebSearcher {
  search<T>(request: WebSearchRequest & { schema: ZodType<T> }): Promise<WebSearchResult<T>>;
}
