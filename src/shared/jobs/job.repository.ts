import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, lte, min, sql } from 'drizzle-orm';
import { DATABASE, type Database, type DbExecutor } from '../db';
import { jobEvents, jobs } from '../db/schema/jobs';
import { type EnqueueRequest, type EnqueueResult, type JobEvent, type JobEventType, type JobRecord } from './job.types';

const CLAIMABLE = ['queued', 'failed'] as const;

@Injectable()
export class JobRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Idempotent on idempotency_key; runs in the caller's transaction when given one (the outbox). */
  async enqueue(request: EnqueueRequest, exec: DbExecutor = this.db): Promise<EnqueueResult> {
    const [created] = await exec
      .insert(jobs)
      .values({
        type: request.type,
        idempotencyKey: request.idempotencyKey,
        payload: request.payload,
        userId: request.userId ?? null,
        ...(request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts }),
        ...(request.runAfter === undefined ? {} : { runAfter: request.runAfter }),
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey })
      .returning();
    if (created) return { job: created, created: true };
    const [existing] = await exec.select().from(jobs).where(eq(jobs.idempotencyKey, request.idempotencyKey));
    if (!existing) throw new Error(`Job with key ${request.idempotencyKey} vanished during enqueue`);
    return { job: existing, created: false };
  }

  findById(id: string): Promise<JobRecord | undefined> {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .then((rows) => rows[0]);
  }

  /**
   * Claims the oldest due job of the given types. SKIP LOCKED lets several claimers run without
   * blocking each other or taking the same row.
   */
  async claimNext(types: string[], now: Date): Promise<JobRecord | undefined> {
    if (types.length === 0) return undefined;
    const candidate = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(inArray(jobs.status, [...CLAIMABLE]), inArray(jobs.type, types), lte(jobs.runAfter, now)))
      .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    const [claimed] = await this.db
      .update(jobs)
      .set({ status: 'running', lockedAt: now, attempts: sql`${jobs.attempts} + 1` })
      .where(inArray(jobs.id, candidate))
      .returning();
    return claimed;
  }

  async succeed(id: string, result: unknown): Promise<void> {
    await this.db.update(jobs).set({ status: 'succeeded', result, error: null, lockedAt: null }).where(eq(jobs.id, id));
  }

  async fail(id: string, error: string, retryAt: Date | null): Promise<void> {
    await this.db
      .update(jobs)
      .set(retryAt ? { status: 'failed', error, runAfter: retryAt, lockedAt: null } : { status: 'dead', error, lockedAt: null })
      .where(eq(jobs.id, id));
  }

  async saveProgress(id: string, progress: unknown): Promise<void> {
    await this.db.update(jobs).set({ progress }).where(eq(jobs.id, id));
  }

  /** On boot: jobs left `running` by a crashed process go back to the queue; attempts are kept. */
  async requeueRunning(): Promise<string[]> {
    const rows = await this.db
      .update(jobs)
      .set({ status: 'queued', lockedAt: null })
      .where(eq(jobs.status, 'running'))
      .returning({ id: jobs.id });
    return rows.map((r) => r.id);
  }

  /** The earliest future run_after among waiting jobs, for the executor's next timer. */
  async nextDue(types: string[]): Promise<Date | null> {
    if (types.length === 0) return null;
    const [row] = await this.db
      .select({ at: min(jobs.runAfter) })
      .from(jobs)
      .where(and(inArray(jobs.status, [...CLAIMABLE]), inArray(jobs.type, types), isNotNull(jobs.runAfter)));
    return row?.at ?? null;
  }

  async appendEvent(jobId: string, type: JobEventType, data: unknown): Promise<JobEvent> {
    const [row] = await this.db.insert(jobEvents).values({ jobId, type, data }).returning();
    if (!row) throw new Error('job_events insert returned no row');
    return row;
  }

  /** Events after `afterId` (SSE Last-Event-ID replay), oldest first. */
  eventsAfter(jobId: string, afterId = 0): Promise<JobEvent[]> {
    return this.db
      .select()
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.id, afterId)))
      .orderBy(asc(jobEvents.id));
  }
}
