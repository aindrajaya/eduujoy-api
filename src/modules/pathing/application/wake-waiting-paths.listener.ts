import { Injectable } from '@nestjs/common';
import { type EventBus } from '../../../shared/events';
import { JobQueue } from '../../../shared/jobs';
import { type ResourcesReady } from '../../discovery/domain/events/resources-ready.event';
import { GENERATE_PATH_JOB } from './jobs';

/** ResourcesReady → the path jobs waiting on that topic and stage run now, not at their next recheck. */
@Injectable()
export class WakeWaitingPaths {
  constructor(private readonly queue: JobQueue) {}

  listen(bus: EventBus): void {
    bus.on<ResourcesReady>('ResourcesReady', (e) => this.queue.wakeWaiting(GENERATE_PATH_JOB, { topicId: e.topicId, stages: [e.stage] }));
  }
}
