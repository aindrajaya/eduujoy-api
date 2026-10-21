export const TOPIC_NORMALIZER = Symbol('TopicNormalizer');

export type TopicDomain = 'software' | 'stem' | 'non_technical';

export interface NormalisedTopic {
  canonicalName: string;
  domain: TopicDomain;
  description: string;
  aliases: string[];
}

/** Turns learner text into a catalog topic (PRD-API §11 `TopicNormalizer`, Claude Haiku 5.5). */
export interface TopicNormalizer {
  normalise(text: string): Promise<NormalisedTopic>;
}
