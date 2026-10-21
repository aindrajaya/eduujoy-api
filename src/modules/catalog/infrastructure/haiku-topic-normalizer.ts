import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PromptRegistry, STRUCTURED_GENERATOR, type StructuredGenerator, wrapUntrusted } from '../../../shared/ai';
import { type NormalisedTopic, type TopicNormalizer } from '../application/ports/topic-normalizer';

export const NORMALISED_TOPIC_SCHEMA = z
  .object({
    canonicalName: z.string().trim().min(1).max(120),
    domain: z.enum(['software', 'stem', 'non_technical']),
    description: z.string().trim().min(1).max(500),
    aliases: z.array(z.string().trim().min(1).max(60)).max(10),
  })
  .strict();

/** TopicNormalizer on Claude Haiku 5.5 (PRD-API §11); the learner text goes in as untrusted data. */
@Injectable()
export class HaikuTopicNormalizer implements TopicNormalizer {
  constructor(
    @Inject(STRUCTURED_GENERATOR) private readonly generator: StructuredGenerator,
    private readonly prompts: PromptRegistry,
  ) {}

  async normalise(text: string): Promise<NormalisedTopic> {
    const { output } = await this.generator.generate({
      stage: 'topic-normalise',
      model: 'claude-haiku-5-5',
      prompt: this.prompts.get('topic-normalise'),
      input: wrapUntrusted('learner-topic', text),
      schema: NORMALISED_TOPIC_SCHEMA,
      maxTokens: 400,
    });
    // Drop aliases that repeat the name or each other, ignoring case.
    const seen = new Set([output.canonicalName.toLowerCase()]);
    const aliases = output.aliases.filter((a) => {
      const key = a.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...output, aliases };
  }
}
