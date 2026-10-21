import { Logger } from '@nestjs/common';
import { type EventEmitter2 } from '@nestjs/event-emitter';
import { type DomainEvent } from './domain-event';

/**
 * In-process domain event bus on EventEmitter2. Listeners are isolated: a throwing listener is logged
 * and never reaches the publisher or the other listeners.
 */
export class EventBus {
  private readonly logger = new Logger(EventBus.name);

  constructor(private readonly emitter: EventEmitter2) {}

  async publish(event: DomainEvent): Promise<void> {
    const listeners = this.emitter.listeners(event.type);
    await Promise.all(
      listeners.map(async (listener) => {
        try {
          await (listener as (e: DomainEvent) => unknown)(event);
        } catch (error) {
          this.logger.error({ err: error instanceof Error ? error : new Error(String(error)), event: event.type }, 'Event listener failed');
        }
      }),
    );
  }

  on<E extends DomainEvent>(type: E['type'], listener: (event: E) => unknown): void {
    this.emitter.on(type, listener as (e: unknown) => unknown);
  }
}
