// Job lifecycle (PRD-API §5): queued → running → succeeded | failed | dead.
// `failed` = the last attempt failed and the job waits for its retry (claimable again at run_after);
// `dead` = attempts exhausted (terminal). Each transition and progress tick is persisted.
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
export type JobEventType = 'progress' | 'partial' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  type: string;
  idempotencyKey: string;
  userId: string | null;
  payload: unknown;
  status: JobStatus;
  progress: unknown;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date | null;
  result: unknown;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueRequest {
  type: string;
  /** Unique per logical job, e.g. `userId:topicId:placementId` (PRD-API §5 table). */
  idempotencyKey: string;
  payload: unknown;
  userId?: string | null;
  maxAttempts?: number;
  runAfter?: Date;
}

export interface EnqueueResult {
  job: JobRecord;
  /** False when the key already existed: the caller gets the existing job (and its stored result). */
  created: boolean;
}

export interface JobEvent {
  id: number;
  jobId: string;
  type: JobEventType;
  data: unknown;
  createdAt: Date;
}
