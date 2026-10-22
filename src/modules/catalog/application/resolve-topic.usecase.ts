import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBudgetGuard, EMBEDDER, type Embedder } from '../../../shared/ai';
import { TOPIC_BANKS, type TopicBanks } from '../../../shared/common/topic-banks';
import { EventBus } from '../../../shared/events';
import {
  clampSimilarity,
  decide,
  fallbackTopicName,
  MAX_CHOICES,
  type Neighbour,
  normaliseTopicText,
  pickRelated,
  queryText,
  relatedCandidates,
  slugify,
  topicDocument,
} from '../domain/resolution';
import { type ResolveMethod, TopicResolved } from '../domain/events/topic-resolved.event';
import { TopicCreateLimitError, TopicSearchUnavailableError, TopicTextInvalidError } from './errors';
import { TOPIC_NORMALIZER, type NormalisedTopic, type TopicNormalizer } from './ports/topic-normalizer';
import { type NearTopic, type NewTopic, TOPIC_REPOSITORY, type TopicRepository, type TopicView } from './ports/topic.repository';

/** New topics a learner may create per UTC day; resolving to existing topics is not capped. */
export const DAILY_TOPIC_CREATE_LIMIT = 10;
/** Nearest neighbours fetched from the HNSW index: the thresholds use the top ones, `related` the rest. */
const NEIGHBOURS = 8;
/** Outage fallback (contract 0.4.0-v0): pg_trgm name/alias similarity that still offers choices. */
export const NAME_FALLBACK_MINIMUM = 0.3;
export const OUTAGE_RETRY_AFTER_SECONDS = 30;

export type ResolveTopicView =
  | { status: 'matched'; topic: TopicView }
  | { status: 'choices'; choices: (TopicView & { similarity: number })[] }
  | { status: 'created'; topic: TopicView; related: TopicView[] };

/** What decided a resolution, for the TopicResolved event and the per-resolve log line. */
interface Signal {
  method: ResolveMethod;
  top: number | null;
  second: number | null;
}

interface Resolution {
  view: ResolveTopicView;
  needsReview: boolean;
  signal: Signal;
  /** `related` candidates for a created topic (contract 0.9.0), before the bank preference. */
  related?: { candidates: Neighbour[]; topics: Map<string, TopicView> };
}

const EXACT: Signal = { method: 'exact', top: 1, second: null };
const CREATE_NEW: Signal = { method: 'create_new', top: null, second: null };

const found = (view: ResolveTopicView, signal: Signal): Resolution => ({ view, needsReview: false, signal });

export interface ResolveOptions {
  /** Contract 0.5.0: skip matching and create from `text` (the learner rejected the choices). */
  createNew?: boolean;
}

/** POST /v1/topics/resolve (FR-01, FR-02): exact name or alias, then vector search, then create. */
@Injectable()
export class ResolveTopic {
  private readonly logger = new Logger(ResolveTopic.name);

  constructor(
    @Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(TOPIC_NORMALIZER) private readonly normalizer: TopicNormalizer,
    @Inject(TOPIC_BANKS) private readonly banks: TopicBanks,
    private readonly budget: AiBudgetGuard,
    private readonly events: EventBus,
  ) {}

  async execute(userId: string, text: string, options: ResolveOptions = {}): Promise<ResolveTopicView> {
    const key = normaliseTopicText(text);
    if (key.length === 0) throw new TopicTextInvalidError('Topic text has no letters or digits');
    const resolution = options.createNew ? await this.create(userId, text, CREATE_NEW, await this.neighbours(userId, text)) : await this.resolve(userId, text, key);
    const { needsReview, signal } = resolution;
    const view = await this.withBanks(resolution);
    const topicId = view.status === 'choices' ? null : view.topic.id;
    // Scores only, never the learner's text: enough to re-tune thresholds from the score distribution.
    this.logger.log({ status: view.status, method: signal.method, topSimilarity: signal.top, secondSimilarity: signal.second, topicId }, 'Topic resolved');
    await this.events.publish(new TopicResolved(userId, view.status, topicId, needsReview, signal.method, signal.top, signal.second));
    return view;
  }

  private async resolve(userId: string, text: string, key: string): Promise<Resolution> {
    // An exact name, alias or slug costs no embedding call; an alias shared by two topics falls through.
    const exact = await this.topics.findExact(key, slugify(key), userId);
    if (exact.length === 1 && exact[0]) return found({ status: 'matched', topic: exact[0] }, EXACT);

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
    const scores = near.map((n) => clampSimilarity(n.similarity)).sort((a, b) => b - a);
    const signal: Signal = { method: 'vector', top: scores[0] ?? null, second: scores[1] ?? null };

    if (decision.kind === 'matched') {
      const topic = byId.get(decision.topicId);
      if (topic) return found({ status: 'matched', topic }, signal);
    }
    if (decision.kind === 'choices') {
      return found({
        status: 'choices',
        choices: decision.choices.flatMap((c) => {
          const topic = byId.get(c.topicId);
          return topic ? [{ ...topic, similarity: c.similarity }] : [];
        }),
      }, signal);
    }
    return this.create(userId, text, signal, near);
  }

  /** createNew skips matching, but `related` still needs the text's neighbours: one cheap query embedding. */
  private async neighbours(userId: string, text: string): Promise<NearTopic[]> {
    try {
      const embedded = await this.embedder.embed({ stage: 'topic-resolve', texts: [queryText(text)], kind: 'query' });
      const vector = embedded.vectors[0];
      return vector ? await this.topics.nearest({ vector, model: embedded.model, version: embedded.version }, NEIGHBOURS, userId) : [];
    } catch (error) {
      this.logger.warn({ err: error }, 'Query embedding failed; the created topic gets no related topics');
      return [];
    }
  }

  /**
   * Contract 0.9.0: every topic in the response carries hasDiagnostic, from one bank lookup; `related`
   * prefers topics that have a bank.
   */
  private async withBanks(resolution: Resolution): Promise<ResolveTopicView> {
    const { view, related } = resolution;
    const shown = view.status === 'choices' ? view.choices.map((c) => c.id) : [view.topic.id];
    const banks = await this.banks.withBank([...shown, ...(related?.candidates.map((c) => c.topicId) ?? [])]);
    const mark = <T extends TopicView>(topic: T): T => ({ ...topic, hasDiagnostic: banks.has(topic.id) });
    if (view.status === 'choices') return { status: 'choices', choices: view.choices.map(mark) };
    if (view.status === 'matched') return { status: 'matched', topic: mark(view.topic) };
    const picked = related ? pickRelated(related.candidates, banks).flatMap((c) => {
      const topic = related.topics.get(c.topicId);
      return topic ? [mark(topic)] : [];
    }) : [];
    return { status: 'created', topic: mark(view.topic), related: picked };
  }

  /** Embedding outage: close names become choices; nothing is ever created, since that would duplicate topics. */
  private async withoutEmbeddings(userId: string, key: string, error: unknown): Promise<Resolution> {
    this.logger.warn({ err: error }, 'Query embedding failed; falling back to name search');
    const near = await this.topics.similarNames(key, NAME_FALLBACK_MINIMUM, MAX_CHOICES, userId);
    if (near.length === 0) throw new TopicSearchUnavailableError(OUTAGE_RETRY_AFTER_SECONDS);
    const choices = near.map((n) => ({ ...n.topic, similarity: clampSimilarity(n.similarity) }));
    return found({ status: 'choices', choices }, { method: 'name_fallback', top: choices[0]?.similarity ?? null, second: choices[1]?.similarity ?? null });
  }

  private async create(userId: string, text: string, signal: Signal, near: NearTopic[]): Promise<Resolution> {
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
        if (existing.length === 1 && existing[0]) return found({ status: 'matched', topic: existing[0] }, signal);
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
    if (result.outcome === 'exists') return found({ status: 'matched', topic: result.topic }, signal);
    const neighbours = near.map((n) => ({ topicId: n.topic.id, similarity: clampSimilarity(n.similarity), domain: n.domain }));
    return {
      view: { status: 'created', topic: result.topic, related: [] },
      needsReview: topic.needsReview,
      signal,
      related: { candidates: relatedCandidates(neighbours, fields.domain, result.topic.id), topics: new Map(near.map((n) => [n.topic.id, n.topic])) },
    };
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
