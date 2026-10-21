import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Embedder, type EmbeddingRequest, type EmbeddingResult } from '../../../src/shared/ai';

/** test/fixtures/catalog/embeddings.json, written by `pnpm catalog:record-golden`. */
export interface GoldenEmbeddings {
  model: string;
  version: number;
  recordedAt: string;
  documents: { title: string; text: string; vector: string }[];
  queries: { text: string; vector: string }[];
}

export const EMBEDDINGS_FILE = join(__dirname, 'embeddings.json');

/** Float32 little-endian, base64: about a third of the JSON-number size, and exact. */
export function encodeVector(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

export function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, 'base64');
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
}

export function loadGoldenEmbeddings(): GoldenEmbeddings | null {
  return existsSync(EMBEDDINGS_FILE) ? (JSON.parse(readFileSync(EMBEDDINGS_FILE, 'utf8')) as GoldenEmbeddings) : null;
}

const key = (kind: 'query' | 'document', text: string, title?: string | null) => `${kind}\u0000${title ?? ''}\u0000${text}`;

/** Replays recorded gemini-embedding-2 vectors; an unrecorded text fails like a provider outage. */
export class RecordedEmbedder implements Embedder {
  private readonly vectors = new Map<string, number[]>();
  readonly misses: string[] = [];

  constructor(private readonly recording: GoldenEmbeddings) {
    for (const d of recording.documents) this.vectors.set(key('document', d.text, d.title), decodeVector(d.vector));
    for (const q of recording.queries) this.vectors.set(key('query', q.text), decodeVector(q.vector));
  }

  embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    for (const [i, text] of request.texts.entries()) {
      const vector = this.vectors.get(key(request.kind, text, request.kind === 'document' ? request.titles?.[i] : null));
      if (!vector) {
        this.misses.push(`${request.kind}: ${text}`);
        return Promise.reject(new Error(`No recorded ${request.kind} embedding for "${text.slice(0, 60)}"`));
      }
      vectors.push(vector);
    }
    const call = { provider: 'google' as const, model: this.recording.model, usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, latencyMs: 0 };
    return Promise.resolve({ vectors, model: this.recording.model, version: this.recording.version, call });
  }
}
