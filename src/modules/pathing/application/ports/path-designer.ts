import { type BudgetScope } from '../../../../shared/ai';
import { type Bloom, type DraftStep, type ResourceType, type Stage } from '../../domain';

export const PATH_DESIGNER = Symbol('PathDesigner');

/** A served card as the designer sees it, under a short alias that code maps back to its resource. */
export interface DesignCard {
  alias: string;
  type: ResourceType;
  title: string;
  source: string;
  stage: Stage;
  bloomLevels: Bloom[];
  durationMin: number | null;
  readingMin: number | null;
  prerequisites: string[];
  concepts: { name: string; start: string | null; end: string | null }[];
  keyTakeaways: string[];
}

export interface DesignRequest {
  topic: { name: string; domain: string };
  placement: { stage: Stage; bloom: Bloom };
  target: Stage;
  goal: string | null;
  weeklyHours: number;
  budgetMinutes: number;
  formats: ('video' | 'text' | 'papers')[];
  cards: DesignCard[];
  /** The concepts the pool's cards teach, most common first (from the cards only, never eval data). */
  coreConcepts: string[];
  /** The learner's formats couldn't be honoured (too few matching cards), so every format is in the pool. */
  formatFallback: boolean;
  /** The validator's errors from the first attempt, for the one regeneration. */
  feedback?: string[];
  jobId?: string;
  budgetScope?: BudgetScope;
  signal?: AbortSignal;
}

/** A checkpoint item with its answer key (stored server-side; never returned to the learner). */
export interface DesignedItem {
  kind: 'single_choice' | 'multi_choice' | 'short_answer' | 'open';
  prompt: string;
  options: { id: string; label: string }[];
  correctOptionIds: string[];
  expectedAnswer: string | null;
}

export type DesignedStep = Omit<DraftStep, 'checkpoint'> & { checkpoint: { items: DesignedItem[]; rubric: string[]; passScore: number } };

export interface DesignedPath {
  steps: DesignedStep[];
  model: string;
  promptVersion: string;
}

/** Designs one path from a pool (PRD-API §11: Sonnet, prompt `path-designer`). */
export interface PathDesigner {
  design(request: DesignRequest): Promise<DesignedPath>;
}
