import { type Tx } from '../../../../shared/db';
import { type BankItem, type Bloom, type DiagnosticState, type Placement, type Progress, type SelfReport } from '../../domain/diagnostic';
import { type DiagnosticBatchView } from '../diagnostic.view';

export const DIAGNOSTIC_REPOSITORY = Symbol('DiagnosticRepository');

/** A gradable bank item plus the learner-facing fields (never the answer key). */
export interface ServedItem {
  item: BankItem;
  bloom: Bloom;
  prompt: string;
  options: { id: string; label: string }[];
}

export interface StoredState {
  engine: DiagnosticState;
  progress: Progress;
}

export interface SessionRecord {
  id: string;
  userId: string;
  topicId: string;
  status: 'in_progress' | 'completed';
  state: StoredState;
  createdAt: Date;
  completedAt: Date | null;
}

export interface PlacementRecord {
  id: string;
  placement: Placement;
}

export interface NewSession {
  userId: string;
  topicId: string;
  goal: string;
  weeklyHours: number;
  preferredFormats: ('video' | 'text' | 'papers')[];
  selfReport: SelfReport | null;
  state: StoredState;
  completed: boolean;
}

/** A stored answers response, replayed for a retry with the same `Idempotency-Key`. */
export interface AnswerReplay {
  sessionId: string;
  requestHash: string;
  response: DiagnosticBatchView;
}

export interface DiagnosticRepository {
  /** Gradable items (choice kinds with an answer key) for the topic. */
  loadBank(topicId: string): Promise<ServedItem[]>;
  findById(id: string): Promise<SessionRecord | null>;
  findOpen(userId: string, topicId: string): Promise<SessionRecord | null>;
  /** Null when another request opened a session for this user and topic first. */
  create(tx: Tx, session: NewSession): Promise<SessionRecord | null>;
  /** Locks the session row for the rest of the transaction (serialises concurrent submissions). */
  lock(tx: Tx, id: string): Promise<SessionRecord | null>;
  saveAnswers(tx: Tx, sessionId: string, answers: { itemId: string; answer: unknown; skipped: boolean; score: number }[]): Promise<void>;
  update(tx: Tx, id: string, state: StoredState, completed: boolean): Promise<void>;
  createPlacement(tx: Tx, input: { sessionId: string; userId: string; topicId: string; placement: Placement; basis: 'items' | 'self_report' }): Promise<string>;
  findPlacement(sessionId: string): Promise<PlacementRecord | null>;
  findReplay(tx: Tx, userId: string, idempotencyKey: string): Promise<AnswerReplay | null>;
  /** False when another request stored this user's key first. */
  saveReplay(tx: Tx, input: AnswerReplay & { userId: string; idempotencyKey: string }): Promise<boolean>;
}
