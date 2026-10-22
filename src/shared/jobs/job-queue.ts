import { type Tx } from '../db';
import { type TxScope } from '../events';
import { type JobRepository } from './job.repository';
import { type EnqueueRequest, type EnqueueResult } from './job.types';

/** Wake-ups from enqueue to the executor (push, not poll: PRD-API §3, Neon free tier). */
export class JobSignals {
  private readonly listeners: (() => void)[] = [];

  onWake(listener: () => void): void {
    this.listeners.push(listener);
  }

  wake(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The `JobQueue` port (PRD-API §3); swap for BullMQ or pg-boss when scaling out. */
export class JobQueue {
  constructor(
    private readonly repo: JobRepository,
    private readonly signals: JobSignals,
  ) {}

  /**
   * Inside a UnitOfWork, pass `{ tx, scope }`: the job row commits with the state change (outbox) and
   * the executor wakes only after commit. Standalone, the executor wakes immediately.
   */
  /** How many jobs of `type` a user triggered since `since` (per-learner caps, D1). */
  countForUser(type: string, userId: string, since: Date): Promise<number> {
    return this.repo.countForUser(type, userId, since);
  }

  async enqueue(request: EnqueueRequest, within?: { tx: Tx; scope: TxScope }): Promise<EnqueueResult> {
    if (within) {
      const result = await this.repo.enqueue(request, within.tx);
      within.scope.afterCommit(() => {
        this.signals.wake();
      });
      return result;
    }
    const result = await this.repo.enqueue(request);
    this.signals.wake();
    return result;
  }
}
