import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type Database } from '../db/database';
import { type DomainEvent } from './domain-event';
import { EventBus } from './event-bus';
import { UnitOfWork } from './unit-of-work';

class ThingHappened implements DomainEvent {
  readonly type = 'ThingHappened';
  readonly occurredAt = new Date('2026-10-21T10:00:00Z');
  constructor(readonly id: string) {}
}

/** Runs the callback like Drizzle would, recording whether we were inside it when listeners fired. */
function fakeDb(log: string[]): Pick<Database, 'transaction'> {
  return {
    transaction: (async (fn: (tx: never) => Promise<unknown>) => {
      log.push('begin');
      const result = await fn({} as never);
      log.push('commit');
      return result;
    }) as Database['transaction'],
  };
}

describe('UnitOfWork', () => {
  const quiet = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  let log: string[];
  let bus: EventBus;
  let uow: UnitOfWork;

  beforeEach(() => {
    log = [];
    quiet.mockClear();
    bus = new EventBus(new EventEmitter2());
    uow = new UnitOfWork(fakeDb(log), bus);
  });

  it('publishes events and runs hooks only after commit, in order', async () => {
    bus.on<ThingHappened>('ThingHappened', (e) => log.push(`event ${e.id}`));

    const result = await uow.run((_tx, scope) => {
      scope.publish(new ThingHappened('a'));
      scope.afterCommit(() => log.push('hook'));
      scope.publish(new ThingHappened('b'));
      log.push('work');
      return Promise.resolve(42);
    });

    expect(result).toBe(42);
    expect(log).toEqual(['begin', 'work', 'commit', 'event a', 'event b', 'hook']);
  });

  it('drops events and hooks when the transaction rolls back', async () => {
    bus.on('ThingHappened', () => log.push('event'));

    await expect(
      uow.run((_tx, scope) => {
        scope.publish(new ThingHappened('a'));
        scope.afterCommit(() => log.push('hook'));
        return Promise.reject(new Error('constraint violated'));
      }),
    ).rejects.toThrow('constraint violated');
    expect(log).toEqual(['begin']);
  });

  it('isolates a failing listener or hook from the publisher and from other listeners', async () => {
    bus.on('ThingHappened', () => {
      throw new Error('listener bug');
    });
    bus.on('ThingHappened', () => log.push('second listener'));

    await expect(
      uow.run((_tx, scope) => {
        scope.publish(new ThingHappened('a'));
        scope.afterCommit(() => {
          throw new Error('hook bug');
        });
        scope.afterCommit(() => log.push('second hook'));
        return Promise.resolve('ok');
      }),
    ).resolves.toBe('ok');
    expect(log).toEqual(['begin', 'commit', 'second listener', 'second hook']);
    expect(quiet).toHaveBeenCalledTimes(2);
  });
});
