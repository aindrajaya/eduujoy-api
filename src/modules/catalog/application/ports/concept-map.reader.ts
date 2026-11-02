import { type ConceptMap } from '../../../../shared/common/concept-map';

export const CONCEPT_MAP_READER = Symbol('ConceptMapReader');

/** Stored concept maps (topic_concept_maps), validated on read. */
export interface ConceptMapReader {
  forTopic(topicId: string): Promise<ConceptMap | null>;
}
