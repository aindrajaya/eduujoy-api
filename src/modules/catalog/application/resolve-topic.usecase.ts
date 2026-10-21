import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBudgetGuard, EMBEDDER, type Embedder } from '../../../shared/ai';
import { EventBus } from '../../../shared/events';
import {
  clampSimilarity,
  decide,
  fallbackTopicName,
  normaliseTopicText,
  queryText,
  slugify,
  topicDocument,
} from '../domain/resolution';
import { TopicResolved } from '../domain/events/topic-resolved.event';
import { TopicCreateLimitError, TopicTextInvalidError } from './errors';
import { TOPIC_NORMALIZER, type NormalisedTopic, type TopicNormalizer } from './ports/topic-normalizer';
import { type NewTopic, TOPIC_REPOSITORY, type TopicRepository, type TopicView } from './ports/topic.repository';

/** New topics a learner may create per UTC day; resolving to existing topics is not capped. */
export const DAILY_TOPIC_CREATE_LIMIT = 10;
/** Nearest neighbours fetched from the HNSW index before applying the thresholds. */
const NEIGHBOURS = 5;

export type ResolveTopicView =
  | { status: 'matched'; topic: TopicView }
  | { status: 'choices'; choices: (TopicView & { similarity: number })[] }
  | { status: 'created'; topic: TopicView };

interface Resolution {
  view: ResolveTopicView;
  needsReview: boolean;
}

const found = (view: ResolveTopicView): Resolution => ({ view, needsReview: false });

/** POST /v1/topics/resolve (FR-01, FR-02): exact name or alias, then vector search, then create. */
@Injectable()
export class ResolveTopic {
  private readonly logger = new Logger(ResolveTopic.name);

  constructor(
    @Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(TOPIC_NORMALIZER) private readonly normalizer: TopicNormalizer,
    private readonly budget: AiBudgetGuard,
    private readonly events: EventBus,
  ) {}

  async execute(userId: string, text: string): Promise<ResolveTopicView> {
    const key = normaliseTopicText(text);
    if (key.length === 0) throw new TopicTextInvalidError('Topic text has no letters or digits');
    const { view, needsReview } = await this.resolve(userId, text, key);
    await this.events.publish(new TopicResolved(userId, view.status, view.status === 'choices' ? null : view.topic.id, needsReview));
    return view;
  }

  private async resolve(userId: string, text: string, key: string): Promise<Resolution> {
    // An exact name, alias or slug costs no embedding call; an alias shared by two topics falls through.
    const exact = await this.topics.findExact(key, slugify(key));
    if (exact.length === 1 && exact[0]) return found({ status: 'matched', topic: exact[0] });

    const embedded = await this.embedder.embed({ stage: 'topic-resolve', texts: [queryText(text)], kind: 'query' });
    const vector = embedded.vectors[0];
    if (!vector) throw new Error('Embedder returned no vector');
    const near = await this.topics.nearest({ vector, model: embedded.model, version: embedded.version }, NEIGHBOURS);
    const byId = new Map(near.map((n) => [n.topic.id, n.topic] as const));
    const decision = decide(near.map((n) => ({ topicId: n.topic.id, similarity: clampSimilarity(n.similarity) })));

    if (decision.kind === 'matched') {
      const topic = byId.get(decision.topicId);
      if (topic) return found({ status: 'matched', topic });
    }
    if (decision.kind === 'choices') {
      return found({
        status: 'choices',
        choices: decision.choices.flatMap((c) => {
          const topic = byId.get(c.topicId);
          return topic ? [{ ...topic, similarity: c.similarity }] : [];
        }),
      });
    }
    return this.create(userId, text);
  }

  private async create(userId: string, text: string): Promise<Resolution> {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if ((await this.topics.countCreatedBy(userId, dayStart)) >= DAILY_TOPIC_CREATE_LIMIT) {
      const nextDay = dayStart.getTime() + 86_400_000;
      throw new TopicCreateLimitError(Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000)));
    }

    const normalised = await this.normalise(text);
    // The normalised name may be one the catalog already has ("reactjs hooks" → "React hooks").
    if (normalised.topic) {
      const names = [normalised.topic.canonicalName, ...normalised.topic.aliases].map(normaliseTopicText);
      for (const name of names) {
        const existing = await this.topics.findExact(name, slugify(name));
        if (existing.length === 1 && existing[0]) return found({ status: 'matched', topic: existing[0] });
      }
    }

    const fields = normalised.topic ?? { canonicalName: fallbackTopicName(text), domain: null, description: null, aliases: [] };
    const topic: NewTopic = {
      slug: slugify(fields.canonicalName),
      canonicalName: fields.canonicalName,
      aliases: fields.aliases,
      description: fields.description,
      domain: fields.domain,
      createdBy: userId,
      needsReview: normalised.topic === null,
      embedding: await this.embedDocument(fields),
    };
    const result = await this.topics.create(topic);
    if (!result.created) return found({ status: 'matched', topic: result.topic });
    return { view: { status: 'created', topic: result.topic }, needsReview: topic.needsReview };
  }

  /** Haiku when the budget allows; otherwise the learner's own words, flagged for review. Never fails. */
  private async normalise(text: string): Promise<{ topic: NormalisedTopic | null }> {
    try {
      await this.budget.assertCanStart('cold');
      return { topic: await this.normalizer.normalise(text) };
    } catch (error) {
      this.logger.warn({ err: error }, 'Topic normaliser unavailable; creating from the learner text for review');
      return { topic: null };
    }
  }

  /** A failed embedding leaves the topic searchable by name until `pnpm catalog:embed-topics` backfills it. */
  private async embedDocument(fields: Pick<NewTopic, 'canonicalName' | 'aliases' | 'description'>): Promise<NewTopic['embedding']> {
    const doc = topicDocument(fields);
    try {
      const result = await this.embedder.embed({ stage: 'topic-create', texts: [doc.text], titles: [doc.title], kind: 'document' });
      const vector = result.vectors[0];
      return vector ? { vector, model: result.model, version: result.version } : null;
    } catch (error) {
      this.logger.warn({ err: error }, 'Topic embedding failed; the backfill will retry');
      return null;
    }
  }
}
