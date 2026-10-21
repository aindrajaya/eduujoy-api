import { Logger } from '@nestjs/common';
import { type Database } from '../db/database';
import { type Tx } from '../db/transaction';
import { type DomainEvent } from './domain-event';
import { type EventBus } from './event-bus';

export interface TxScope {
  /** Publish once the transaction commits; dropped on rollback. */
  publish(event: DomainEvent): void;
  /** Run once the transaction commits (for example, wake the job executor); dropped on rollback. */
  afterCommit(hook: () => unknown): void;
}

/**
 * PRD-API §5: state changes and the job row (the outbox) commit together, and events are emitted only
 * after commit. Handlers never run inside the publisher's transaction.
 */
export class UnitOfWork {
  private readonly logger = new Logger(UnitOfWork.name);

  constructor(
    private readonly db: Pick<Database, 'transaction'>,
    private readonly bus: EventBus,
  ) {}

  async run<T>(work: (tx: Tx, scope: TxScope) => Promise<T>): Promise<T> {
    const events: DomainEvent[] = [];
    const hooks: (() => unknown)[] = [];
    const scope: TxScope = {
      publish: (event) => events.push(event),
      afterCommit: (hook) => hooks.push(hook),
    };

    const result = await this.db.transaction((tx) => work(tx, scope));

    for (const event of events) await this.bus.publish(event);
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'After-commit hook failed');
      }
    }
    return result;
  }
}
