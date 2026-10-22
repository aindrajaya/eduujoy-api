import { type Bloom, type Concept, type Quality, type Stage } from '../../domain';
import { type DiscoveryTopic } from './web-discovery';

export const RESOURCE_ANALYZER = Symbol('ResourceAnalyzer');

export interface AnalysisInput {
  kind: 'video' | 'text';
  topic: DiscoveryTopic;
  /** The stage the pool is for; the analyser tags the resource's own stage independently. */
  poolStage: Stage;
  url: string;
  title: string;
  source: string;
  durationMin: number | null;
  /** Videos only: the frame rate and optional end offset that keep the analysis inside the cap. */
  clip?: { fps: number; endSec: number | null };
  /** Page text or a paper abstract (untrusted); null for videos. */
  content: string | null;
  jobId?: string;
  signal?: AbortSignal;
}

/** The ResourceCard fields the analyser fills (master PRD §8), already Zod-checked. */
export interface Analysis {
  dreyfusStage: Stage;
  bloomLevels: Bloom[];
  prerequisites: string[];
  concepts: Concept[];
  keyTakeaways: string[];
  whyThis: string | null;
  quality: Quality;
  confidence: number;
  evidence: string;
  language: string;
  readingMin: number | null;
  model: string;
  /** Input tokens the analysis actually used (uncached plus cache reads), for the cap check. */
  inputTokens: number;
}

/** Gemini video and text analysis (`VideoAnalyzer`, `TextAnalyzer` in PRD-API §11). */
export interface ResourceAnalyzer {
  /** Cards are cached per prompt version (PRD-API §10); a bump re-analyses. */
  readonly promptVersion: string;
  analyse(input: AnalysisInput): Promise<Analysis>;
}
