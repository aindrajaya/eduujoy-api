import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBudgetGuard, EMBEDDER, type Embedder } from '../../../shared/ai';
import { EventBus } from '../../../shared/events';
import {
  clampSimilarity,
  decide,
  fallbackTopicName,
  MAX_CHOICES,
  normaliseTopicText,
  queryText,
  slugify,
  topicDocument,
} from '../domain/resolution';
import { TopicResolved } from '../domain/events/topic-resolved.event';
import { TopicCreateLimitError, TopicSearchUnavailableError, TopicTextInvalidError } from './errors';
import { TOPIC_NORMALIZER, type NormalisedTopic, type TopicNormalizer } from './ports/topic-normalizer';
import { type NewTopic, TOPIC_REPOSITORY, type TopicRepository, type TopicView } from './ports/topic.repository';

/** New topics a learner may create per UTC day; resolving to existing topics is not capped. */
export const DAILY_TOPIC_CREATE_LIMIT = 10;
/** Nearest neighbours fetched from the HNSW index before applying the thresholds. */
const NEIGHBOURS = 5;
/** Outage fallback (contract 0.4.0-v0): pg_trgm name/alias similarity that still offers choices. */
export const NAME_FALLBACK_MINIMUM = 0.3;
export const OUTAGE_RETRY_AFTER_SECONDS = 30;

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
    const exact = await this.topics.findExact(key, slugify(key), userId);
    if (exact.length === 1 && exact[0]) return found({ status: 'matched', topic: exact[0] });

    let embedded;
    try {
      embedded = await this.embedder.embed({ stage: 'topic-resolve', texts: [queryText(text)], kind: 'query' });
    } catch (error) {
      return this.withoutEmbeddings(userId, key, error);
    }
    const vector = embedded.vectors[0];
    if (!vector) return this.withoutEmbeddings(userId, key, new Error('Embedder returned no vector'));
    const near = await this.topics.nearest({ vector, model: embedded.model, version: embedded.version }, NEIGHBOURS, userId);
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

  /** Embedding outage: close names become choices; nothing is ever created, since that would duplicate topics. */
  private async withoutEmbeddings(userId: string, key: string, error: unknown): Promise<Resolution> {
    this.logger.warn({ err: error }, 'Query embedding failed; falling back to name search');
    const near = await this.topics.similarNames(key, NAME_FALLBACK_MINIMUM, MAX_CHOICES, userId);
    if (near.length === 0) throw new TopicSearchUnavailableError(OUTAGE_RETRY_AFTER_SECONDS);
    return found({ status: 'choices', choices: near.map((n) => ({ ...n.topic, similarity: clampSimilarity(n.similarity) })) });
  }

  private async create(userId: string, text: string): Promise<Resolution> {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const limited = (): TopicCreateLimitError => new TopicCreateLimitError(Math.max(1, Math.ceil((dayStart.getTime() + 86_400_000 - now.getTime()) / 1000)));
    // Cheap pre-check so a capped learner costs no Haiku call; create() enforces the cap atomically.
    if ((await this.topics.countCreatedBy(userId, dayStart)) >= DAILY_TOPIC_CREATE_LIMIT) throw limited();

    const normalised = await this.normalise(text);
    // The normalised name may be one the catalog already has ("reactjs hooks" → "React hooks").
    if (normalised.topic) {
      const names = [normalised.topic.canonicalName, ...normalised.topic.aliases].map(normaliseTopicText);
      for (const name of names) {
        const existing = await this.topics.findExact(name, slugify(name), userId);
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
    const result = await this.topics.create(topic, { since: dayStart, max: DAILY_TOPIC_CREATE_LIMIT });
    if (result.outcome === 'limited') throw limited();
    if (result.outcome === 'exists') return found({ status: 'matched', topic: result.topic });
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
