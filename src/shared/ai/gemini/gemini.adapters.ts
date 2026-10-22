import { ApiError, type Content, FinishReason, type GenerateContentConfig, type GenerateContentResponse, GoogleGenAI, MediaResolution } from '@google/genai';
import { MODELS, type TokenUsage } from '../catalog';
import { AiCallError, classifyStatus } from '../errors';
import { toStructuredSchema } from '../json-schema';
import {
  type Embedder,
  type EmbeddingRequest,
  type EmbeddingResult,
  type StructuredGenerator,
  type StructuredRequest,
  type StructuredResult,
} from '../ports';
import { withRetry } from '../retry';
import { UNTRUSTED_DATA_RULE } from '../untrusted';

const DEFAULT_MAX_TOKENS = 16_000;
export const EMBEDDING_MODEL = 'gemini-embedding-2';
export const EMBEDDING_DIMENSIONS = 768;
/** Bump when the embedding model or dimensions change (stored as embedding_version). */
export const EMBEDDING_VERSION = 1;

export interface GeminiOptions {
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source for retries (tests pin it; defaults to Math.random). */
  random?: () => number;
}

export interface GeminiClientOptions {
  baseUrl?: string;
  /** Injected in tests: Jest's sandbox lacks the undici global dispatcher genai's default fetch uses. */
  fetch?: typeof fetch;
}

/** Retries are ours (withRetry) so both providers follow PRD-API §11; the SDK's own are off. */
export function createGeminiClient(apiKey: string, options: GeminiClientOptions = {}): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: { attempts: 1 },
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
}

function toAiError(error: unknown): AiCallError {
  if (error instanceof AiCallError) return error;
  if (error instanceof ApiError) {
    const status: unknown = error.status;
    const code = typeof status === 'number' ? status : undefined;
    return new AiCallError(classifyStatus(code), `Gemini API error ${String(code)}`, code);
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new AiCallError('timeout', 'Gemini request timed out');
  }
  throw error;
}

export function geminiUsage(response: GenerateContentResponse): TokenUsage {
  const meta = response.usageMetadata;
  const prompt = meta?.promptTokenCount ?? 0;
  const cached = meta?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: prompt - cached,
    cacheWriteTokens: 0,
    cacheReadTokens: cached,
    // Thinking tokens are billed as output.
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
  };
}

/** Folds a streamed reply into one response: the text joined, usage and finish reason from the last chunk. */
async function collect(stream: AsyncGenerator<GenerateContentResponse>): Promise<GenerateContentResponse> {
  let text = '';
  let last: GenerateContentResponse | undefined;
  for await (const chunk of stream) {
    text += chunk.text ?? '';
    last = chunk;
  }
  if (!last) throw new AiCallError('server', 'Gemini returned an empty stream');
  const candidate = last.candidates?.[0];
  return Object.assign(Object.create(Object.getPrototypeOf(last) as object) as GenerateContentResponse, last, {
    candidates: [{ ...candidate, content: { role: 'model', parts: [{ text }] } }],
  });
}

export class GeminiStructuredGenerator implements StructuredGenerator {
  constructor(
    private readonly client: GoogleGenAI,
    private readonly options: GeminiOptions = {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const spec = MODELS[request.model];
    if (spec.provider !== 'google') throw new Error(`${request.model} is not a Gemini model`);
    const started = this.now();

    const config: GenerateContentConfig = {
      systemInstruction: `${request.prompt.text}\n\n${UNTRUSTED_DATA_RULE}`,
      responseMimeType: 'application/json',
      responseJsonSchema: toStructuredSchema(request.schema),
      maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      httpOptions: { timeout: spec.timeoutMs },
      ...(request.signal ? { abortSignal: request.signal } : {}),
      // Low resolution cuts video tokens roughly threefold; tags and timestamps come mostly from audio.
      ...(request.media ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW } : {}),
    };
    const response = await withRetry(
      async () => {
        try {
          if (!request.media) return await this.client.models.generateContent({ model: request.model, contents: request.input, config });
          // A public YouTube URL goes in as file data (ai.google.dev/gemini-api/docs/video-understanding);
          // video calls stream so a long analysis never sits on an idle connection (PRD-API §11).
          const contents: Content[] = [{ role: 'user', parts: [{ fileData: { fileUri: request.media.youtubeUrl } }, { text: request.input }] }];
          return await collect(await this.client.models.generateContentStream({ model: request.model, contents, config }));
        } catch (error) {
          throw toAiError(error);
        }
      },
      { retries: 2, baseDelayMs: 500, ...(this.options.sleep ? { sleep: this.options.sleep } : {}), ...(this.options.random ? { random: this.options.random } : {}) },
    );

    const call = {
      provider: 'google' as const,
      model: response.modelVersion ?? request.model,
      usage: geminiUsage(response),
      latencyMs: Math.round(this.now() - started),
    };
    const finish = response.candidates?.[0]?.finishReason;
    if (response.promptFeedback?.blockReason || finish === FinishReason.SAFETY || finish === FinishReason.PROHIBITED_CONTENT) {
      throw new AiCallError('refused', 'Gemini blocked the request', undefined, call);
    }
    if (finish === FinishReason.MAX_TOKENS) throw new AiCallError('invalid_output', 'Gemini output was truncated', undefined, call);

    let json: unknown;
    try {
      json = JSON.parse(response.text ?? '');
    } catch {
      throw new AiCallError('invalid_output', 'Gemini returned invalid JSON', undefined, call);
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw new AiCallError('invalid_output', `Gemini output failed validation: ${parsed.error.message}`, undefined, call);
    }
    return { output: parsed.data, call };
  }
}

/**
 * gemini-embedding-2 takes no task_type; asymmetric retrieval uses text prefixes instead
 * (ai.google.dev/gemini-api/docs/embeddings). A document without a title uses `title: none`.
 */
export function formatEmbeddingInput(request: Pick<EmbeddingRequest, 'texts' | 'kind' | 'titles'>): string[] {
  return request.texts.map((text, i) =>
    request.kind === 'query'
      ? `task: search result | query: ${text}`
      : `title: ${request.titles?.[i]?.trim() || 'none'} | text: ${text}`,
  );
}

export class GeminiEmbedder implements Embedder {
  constructor(
    private readonly client: GoogleGenAI,
    private readonly options: GeminiOptions = {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const started = this.now();
    const response = await withRetry(
      async () => {
        try {
          return await this.client.models.embedContent({
            model: EMBEDDING_MODEL,
            // One Content per text: plain strings (or parts of one Content) are combined into a single
            // embedding by gemini-embedding-2. Truncated 768-dim vectors come back already normalised.
            contents: formatEmbeddingInput(request).map((text) => ({ parts: [{ text }] })),
            config: {
              outputDimensionality: EMBEDDING_DIMENSIONS,
              httpOptions: { timeout: MODELS[EMBEDDING_MODEL].timeoutMs },
            },
          });
        } catch (error) {
          throw toAiError(error);
        }
      },
      { retries: 2, baseDelayMs: 500, ...(this.options.sleep ? { sleep: this.options.sleep } : {}), ...(this.options.random ? { random: this.options.random } : {}) },
    );

    const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== request.texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new AiCallError('invalid_output', `Expected ${request.texts.length} vectors of ${EMBEDDING_DIMENSIONS} dims`);
    }
    // The embeddings API returns no token count; estimate ~4 characters per token for metering.
    const estimatedTokens = request.texts.reduce((n, text) => n + Math.ceil(text.length / 4), 0);
    return {
      vectors,
      model: EMBEDDING_MODEL,
      version: EMBEDDING_VERSION,
      call: {
        provider: 'google',
        model: EMBEDDING_MODEL,
        usage: { inputTokens: estimatedTokens, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
        latencyMs: Math.round(this.now() - started),
      },
    };
  }
}
