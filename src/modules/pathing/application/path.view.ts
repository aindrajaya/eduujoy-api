import { type ServedCard } from '../../discovery/application/ports/card.reader';
import { type Bloom, type Stage } from '../domain';
import { type PathStatus, type PathSummaryRecord, type StepRecord, type StoredCheckpoint } from './ports/path.repository';

// Contract views (PathSummary, Path, PathStep, Resource); the controller serialises these as is.

export interface ResourceView {
  id: string;
  type: ServedCard['type'];
  url: string;
  youtubeId: string | null;
  title: string;
  source: string;
  durationMin: number | null;
  readingMin: number | null;
  published: string | null;
  language: string;
  stage: Stage;
  bloomLevels: Bloom[];
  prerequisites: string[];
  concepts: { name: string; start: string | null; end: string | null }[];
  keyTakeaways: string[];
  whyThis?: string;
  quality: ServedCard['quality'];
}

export interface StepView {
  id: string;
  n: number;
  objective: string;
  bloom: Bloom;
  actions: { n: number; text: string; done: boolean }[];
  resources: ResourceView[];
  checkpoint: StoredCheckpoint;
  doneWhen: string;
  estMinutes: number;
  status: StepRecord['status'];
  remedial: boolean;
  difficulty: StepRecord['difficulty'];
}

export interface TopicRef {
  id: string;
  [key: string]: unknown;
}

export interface PathSummaryView {
  id: string;
  topic: TopicRef;
  from: { stage: Stage; bloom: Bloom };
  to: { stage: Stage; bloom: Bloom };
  status: PathStatus;
  totalHours: number;
  stepsDone: number;
  stepsTotal: number;
  createdAt: string;
  currentStep: { id: string; n: number; objective: string; bloom: Bloom; estMinutes: number; status: StepRecord['status'] } | null;
}

export type PathView = PathSummaryView & { steps: StepView[] };

export function resourceView(card: ServedCard): ResourceView {
  return {
    id: card.resourceId,
    type: card.type,
    url: card.url,
    youtubeId: card.youtubeId,
    title: card.title,
    source: card.source,
    durationMin: card.durationMin,
    readingMin: card.readingMin,
    published: card.published,
    language: card.language,
    stage: card.stage,
    bloomLevels: card.bloomLevels,
    prerequisites: card.prerequisites,
    concepts: card.concepts.map((c) => ({ name: c.name, start: c.start ?? null, end: c.end ?? null })),
    keyTakeaways: card.keyTakeaways.slice(0, 5),
    ...(card.whyThis ? { whyThis: card.whyThis } : {}),
    quality: card.quality,
  };
}

/** A step with its resources, in the order the step cites them (a missing card is left out). */
export function stepView(step: StepRecord, cards: Map<string, ServedCard>): StepView {
  return {
    id: step.id,
    n: step.n,
    objective: step.objective,
    bloom: step.bloom,
    actions: step.actions,
    resources: step.resourceIds.flatMap((id) => (cards.has(id) ? [resourceView(cards.get(id) as ServedCard)] : [])),
    checkpoint: step.checkpoint,
    doneWhen: step.doneWhen,
    estMinutes: step.estMinutes,
    status: step.status,
    remedial: step.remedial,
    difficulty: step.difficulty,
  };
}

export function summaryView(record: PathSummaryRecord, topic: TopicRef): PathSummaryView {
  return {
    id: record.id,
    topic,
    from: record.from,
    to: record.to,
    status: record.status,
    totalHours: Math.round((record.totalMinutes / 60) * 10) / 10,
    stepsDone: record.stepsDone,
    stepsTotal: record.stepsTotal,
    createdAt: record.createdAt.toISOString(),
    currentStep: record.currentStep,
  };
}
