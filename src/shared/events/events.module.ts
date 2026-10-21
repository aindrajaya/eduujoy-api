import { Global, Module } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { DATABASE, type Database } from '../db';
import { EventBus } from './event-bus';
import { UnitOfWork } from './unit-of-work';

@Global()
@Module({
  imports: [EventEmitterModule.forRoot({ wildcard: false })],
  providers: [
    { provide: EventBus, inject: [EventEmitter2], useFactory: (emitter: EventEmitter2) => new EventBus(emitter) },
    { provide: UnitOfWork, inject: [DATABASE, EventBus], useFactory: (db: Database, bus: EventBus) => new UnitOfWork(db, bus) },
  ],
  exports: [EventBus, UnitOfWork],
})
export class EventsModule {}
