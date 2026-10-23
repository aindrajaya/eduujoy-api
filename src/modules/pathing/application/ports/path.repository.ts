import { type Tx } from '../../../../shared/db';
import { type Bloom, type Stage } from '../../domain';
import { type DesignedItem } from './path-designer';

export const PATH_REPOSITORY = Symbol('PathRepository');

export type PathStatus = 'generating' | 'active' | 'completed' | 'failed' | 'under_review';
export type StepStatus = 'locked' | 'active' | 'completed' | 'skipped';
export type Difficulty = 'too_easy' | 'ok' | 'too_hard';

export interface PathRecord {
  id: string;
  userId: string;
  topicId: string;
  placementId: string | null;
  from: { stage: Stage; bloom: Bloom };
  to: { stage: Stage; bloom: Bloom };
  status: PathStatus;
  goal: string | null;
  weeklyHours: number | null;
  jobId: string | null;
  refundedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A checkpoint as the contract shows it (items without answer keys). */
export interface StoredCheckpoint {
  items: { id: string; kind: DesignedItem['kind']; prompt: string; options?: { id: string; label: string }[] }[];
  rubric: string[];
  passScore: number;
}

export interface StepRecord {
  id: string;
  pathId: string;
  n: number;
  objective: string;
  bloom: Bloom;
  actions: { n: number; text: string; done: boolean }[];
  resourceIds: string[];
  checkpoint: StoredCheckpoint;
  doneWhen: string;
  estMinutes: number;
  status: StepStatus;
  remedial: boolean;
  difficulty: Difficulty | null;
}

export type NewStep = Omit<StepRecord, 'id' | 'pathId' | 'status' | 'remedial' | 'difficulty'> & {
  answerKeys: { correctOptionIds: string[]; expectedAnswer: string | null }[];
};

export interface PathSummaryRecord extends PathRecord {
  stepsDone: number;
  stepsTotal: number;
  totalMinutes: number;
  currentStep: Pick<StepRecord, 'id' | 'n' | 'objective' | 'bloom' | 'estMinutes' | 'status'> | null;
}

export interface PathReplay {
  pathId: string;
  requestHash: string;
  response: { jobId: string; status: string; eventsUrl: string };
}

export interface ListFilter {
  status?: PathStatus;
  topicId?: string;
  /** Opaque cursor: the last row's created_at and id. */
  before?: { createdAt: Date; id: string };
  limit: number;
}

export interface StepPatch {
  actionsDone?: { n: number; done: boolean }[];
  difficulty?: Difficulty;
  status?: 'completed' | 'skipped';
}

export type StepPatchOutcome = { kind: 'ok'; step: StepRecord; pathCompleted: boolean; unlocked: StepRecord | null } | { kind: 'not_found' } | { kind: 'not_active' };

export interface PathRepository {
  /** Null when this learner already has a live path for the placement (the partial unique index). */
  create(
    tx: Tx,
    input: { userId: string; topicId: string; placementId: string; from: PathRecord['from']; to: PathRecord['to']; goal: string | null; weeklyHours: number },
  ): Promise<string | null>;
  findLiveForPlacement(userId: string, placementId: string): Promise<PathRecord | null>;
  setJob(tx: Tx, pathId: string, jobId: string): Promise<void>;
  findReplay(userId: string, idempotencyKey: string): Promise<PathReplay | null>;
  /** False when another request stored this key first. */
  saveReplay(tx: Tx, input: PathReplay & { userId: string; idempotencyKey: string }): Promise<boolean>;
  countCreatedSince(userId: string, since: Date): Promise<number>;

  findById(pathId: string): Promise<PathRecord | null>;
  /** Steps saved and the path made active, only while it is still generating; false otherwise. */
  activate(tx: Tx, pathId: string, steps: NewStep[], meta: { model: string; promptVersion: string }): Promise<boolean>;
  /** Only from generating; false otherwise. */
  setStatus(tx: Tx, pathId: string, from: PathStatus, to: PathStatus, meta?: { model: string; promptVersion: string }): Promise<boolean>;
  /** Sets refunded_at once; false when it was already set. */
  markRefunded(tx: Tx, pathId: string): Promise<boolean>;

  list(userId: string, filter: ListFilter): Promise<PathSummaryRecord[]>;
  summary(userId: string, pathId: string): Promise<PathSummaryRecord | null>;
  steps(pathId: string): Promise<StepRecord[]>;
  patchStep(userId: string, stepId: string, patch: StepPatch): Promise<StepPatchOutcome>;

  /**
   * under_review paths, not refunded, that entered review before `cutoff` (the 48 h deadline). A reviewer's
   * approval moves a path out of under_review, so its updated_at marks when review began.
   */
  reviewOverdue(cutoff: Date, limit: number): Promise<PathRecord[]>;
}
