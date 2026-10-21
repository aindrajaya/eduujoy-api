import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../../shared/events';
import { type PlacementComputed } from '../../assessment/domain/events/placement-computed.event';
import { RecordPosition } from '../application/record-position.usecase';

/** PRD-API §5: PlacementComputed → progress records the learner's position (source: diagnostic). */
@Injectable()
export class PlacementComputedListener implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly record: RecordPosition,
  ) {}

  onModuleInit(): void {
    this.bus.on<PlacementComputed>('PlacementComputed', (event) =>
      this.record.execute({
        userId: event.userId,
        topicId: event.topicId,
        stage: event.stage,
        bloom: event.bloom,
        confidence: event.confidence,
        source: 'diagnostic',
      }),
    );
  }
}
