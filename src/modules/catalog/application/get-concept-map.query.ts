import { Inject, Injectable } from '@nestjs/common';
import { type ConceptMap } from '../../../shared/common/concept-map';
import { CONCEPT_MAP_READER, type ConceptMapReader } from './ports/concept-map.reader';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public catalog query (user, 3 Nov 2026): a topic's concept map, or null when it has none (learner
 * topics, or a seed topic whose map was not loaded). Pathing reads maps only through this, never files.
 */
@Injectable()
export class GetConceptMapQuery {
  constructor(@Inject(CONCEPT_MAP_READER) private readonly maps: ConceptMapReader) {}

  execute(topicId: string): Promise<ConceptMap | null> {
    return UUID.test(topicId) ? this.maps.forTopic(topicId) : Promise.resolve(null);
  }
}
