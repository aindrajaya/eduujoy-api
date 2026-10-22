import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
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
   * blocking each other or taking the same row. All job times use the database clock (run_after
   * defaults to its now()), so app-server clock skew never changes what counts as due.
   */
  async claimNext(types: string[]): Promise<JobRecord | undefined> {
    if (types.length === 0) return undefined;
    const candidate = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(inArray(jobs.status, [...CLAIMABLE]), inArray(jobs.type, types), lte(jobs.runAfter, sql`now()`)))
      .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    const [claimed] = await this.db
      .update(jobs)
      // Millisecond precision: locked_at is the run's ownership token and must round-trip through a JS Date.
      .set({ status: 'running', lockedAt: sql`date_trunc('milliseconds', now())`, attempts: sql`${jobs.attempts} + 1` })
      .where(inArray(jobs.id, candidate))
      .returning();
    return claimed;
  }

  /** The claim a run holds; writes only land while the row still carries this exact lock. */
  private owned(claim: { id: string; lockedAt: Date }): ReturnType<typeof and> {
    return and(eq(jobs.id, claim.id), eq(jobs.status, 'running'), eq(jobs.lockedAt, claim.lockedAt));
  }

  /** False when another instance took the job over (stale requeue), so this run's result is dropped. */
  async succeed(claim: { id: string; lockedAt: Date }, result: unknown): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ status: 'succeeded', result, error: null, lockedAt: null })
      .where(this.owned(claim))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  /** `retryInMs` schedules the retry on the database clock; null marks the job dead. */
  async fail(claim: { id: string; lockedAt: Date }, error: string, retryInMs: number | null): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set(
        retryInMs === null
          ? { status: 'dead', error, lockedAt: null }
          : { status: 'failed', error, runAfter: sql`now() + make_interval(secs => ${retryInMs / 1000})`, lockedAt: null },
      )
      .where(this.owned(claim))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  /** On stop: put this instance's unfinished claims back in the queue (attempts kept). */
  async release(claims: { id: string; lockedAt: Date }[]): Promise<string[]> {
    const released: string[] = [];
    for (const claim of claims) {
      const rows = await this.db
        .update(jobs)
        .set({ status: 'queued', lockedAt: null })
        .where(this.owned(claim))
        .returning({ id: jobs.id });
      if (rows.length > 0) released.push(claim.id);
    }
    return released;
  }

  async saveProgress(id: string, progress: unknown): Promise<void> {
    await this.db.update(jobs).set({ progress }).where(eq(jobs.id, id));
  }

  /**
   * Requeues `running` jobs locked more than `staleAfterMs` ago: their process is gone (a live one would
   * have timed the job out by now). Recent locks may belong to an overlapping deploy and are left alone.
   */
  async requeueStale(staleAfterMs: number): Promise<string[]> {
    const rows = await this.db
      .update(jobs)
      .set({ status: 'queued', lockedAt: null })
      .where(and(eq(jobs.status, 'running'), lt(jobs.lockedAt, sql`now() - make_interval(secs => ${staleAfterMs / 1000})`)))
      .returning({ id: jobs.id });
    return rows.map((r) => r.id);
  }

  /** Milliseconds until the oldest remaining running lock goes stale, or null if nothing runs. */
  async msUntilNextStale(staleAfterMs: number): Promise<number | null> {
    const [row] = await this.db
      .select({ ms: sql<string | null>`extract(epoch from (min(${jobs.lockedAt}) + make_interval(secs => ${staleAfterMs / 1000}) - now())) * 1000` })
      .from(jobs)
      .where(eq(jobs.status, 'running'));
    return row?.ms == null ? null : Number(row.ms);
  }

  /**
   * Milliseconds until the earliest *future* run_after among waiting jobs of `types` (database clock),
   * for the executor's next timer. Jobs already due are not counted: either a slot frees up (and the
   * finishing job pumps) or they were just claimed.
   */
  async msUntilNextDue(types: string[]): Promise<number | null> {
    if (types.length === 0) return null;
    const [row] = await this.db
      .select({ ms: sql<string | null>`extract(epoch from (min(${jobs.runAfter}) - now())) * 1000` })
      .from(jobs)
      .where(and(inArray(jobs.status, [...CLAIMABLE]), inArray(jobs.type, types), gt(jobs.runAfter, sql`now()`)));
    return row?.ms == null ? null : Number(row.ms);
  }

  /**
   * Account deletion (A13): removes the learner's jobs that aren't running (their events cascade).
   * A running job finishes on its own; deleting the user then sets its user_id to null.
   */
  async deleteForUser(userId: string, exec: DbExecutor = this.db): Promise<number> {
    const rows = await exec
      .delete(jobs)
      .where(and(eq(jobs.userId, userId), sql`${jobs.status} <> 'running'`))
      .returning({ id: jobs.id });
    return rows.length;
  }

  /**
   * Deletes finished jobs (succeeded or dead) last updated more than `olderThanMs` ago; their
   * job_events go with them (ON DELETE CASCADE). Keeps the Neon free tier's 1 GB in check.
   */
  async pruneFinished(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .delete(jobs)
      .where(
        and(
          inArray(jobs.status, ['succeeded', 'dead']),
          lt(jobs.updatedAt, sql`now() - make_interval(secs => ${olderThanMs / 1000})`),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length;
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
