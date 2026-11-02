import { Inject, Injectable } from '@nestjs/common';
import { PLACEMENT_READER, type PlacementForPath, type PlacementReader } from './ports/placement.reader';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pathing (A9) reads a learner's placement; another learner's or a missing one is null (404). */
@Injectable()
export class GetPlacementForPathQuery {
  constructor(@Inject(PLACEMENT_READER) private readonly reader: PlacementReader) {}

  async execute(userId: string, placementId: string): Promise<PlacementForPath | null> {
    if (!UUID.test(placementId)) return null;
    const placement = await this.reader.findForPath(placementId);
    return placement?.userId === userId ? placement : null;
  }
}
