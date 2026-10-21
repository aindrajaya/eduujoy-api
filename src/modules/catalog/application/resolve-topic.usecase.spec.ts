import { EventEmitter2 } from '@nestjs/event-emitter';
import { type AiBudgetGuard, AiBudgetExceededError, type Embedder, type EmbeddingRequest } from '../../../shared/ai';
import { EventBus } from '../../../shared/events/event-bus';
import { type TopicResolved } from '../domain/events/topic-resolved.event';
import { FakeTopicRepository } from './catalog.fakes';
import { TopicCreateLimitError, TopicTextInvalidError } from './errors';
import { type NormalisedTopic, type TopicNormalizer } from './ports/topic-normalizer';
import { DAILY_TOPIC_CREATE_LIMIT, ResolveTopic } from './resolve-topic.usecase';

const MODEL = { model: 'fake-embedding', version: 1 };

/** A unit vector at `angle` radians in 2D, padded to 3 dims: cos(a - b) is the similarity. */
const at = (angle: number): number[] => [Math.cos(angle), Math.sin(angle), 0];
const similarityAngle = (similarity: number): number => Math.acos(similarity);

class ScriptedEmbedder implements Embedder {
  readonly requests: EmbeddingRequest[] = [];
  queries = new Map<string, number[]>();
  failDocuments = false;

  embed(request: EmbeddingRequest) {
    this.requests.push(request);
    if (request.kind === 'document' && this.failDocuments) return Promise.reject(new Error('gemini down'));
    const vectors = request.texts.map((t) => (request.kind === 'query' ? (this.queries.get(t) ?? [0, 0, 1]) : at(3)));
    const call = { provider: 'google' as const, model: MODEL.model, usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, latencyMs: 1 };
    return Promise.resolve({ vectors, ...MODEL, call });
  }
}

class ScriptedNormalizer implements TopicNormalizer {
  calls: string[] = [];
  result: NormalisedTopic = { canonicalName: 'Sourdough baking', domain: 'non_technical', description: 'Baking bread with a wild yeast starter.', aliases: ['sourdough'] };
  fail = false;

  normalise(text: string): Promise<NormalisedTopic> {
    this.calls.push(text);
    return this.fail ? Promise.reject(new Error('haiku down')) : Promise.resolve(this.result);
  }
}

function setup() {
  const repo = new FakeTopicRepository();
  const embedder = new ScriptedEmbedder();
  const normalizer = new ScriptedNormalizer();
  let budgetExceeded = false;
  const budget = { assertCanStart: () => (budgetExceeded ? Promise.reject(new AiBudgetExceededError(3, 3)) : Promise.resolve()) } as unknown as AiBudgetGuard;
  const bus = new EventBus(new EventEmitter2());
  const events: TopicResolved[] = [];
  bus.on<TopicResolved>('TopicResolved', (e) => events.push(e));
  const hooks = repo.add({ slug: 'react-hooks', canonicalName: 'React hooks', aliases: ['hooks', 'useState'], embedding: { vector: at(0), ...MODEL } });
  const react = repo.add({ slug: 'react', canonicalName: 'React', embedding: { vector: at(1.2), ...MODEL } });
  const vue = repo.add({ slug: 'vue', canonicalName: 'Vue', embedding: { vector: at(-1.2), ...MODEL } });
  return {
    repo,
    embedder,
    normalizer,
    events,
    topics: { hooks, react, vue },
    exceedBudget: () => {
      budgetExceeded = true;
    },
    resolve: new ResolveTopic(repo, embedder, normalizer, budget, bus),
  };
}

describe('ResolveTopic', () => {
  it('matches an exact name, alias or slug without an embedding call', async () => {
    const t = setup();

    for (const text of ['React Hooks', ' useState ', 'react-hooks']) {
      await expect(t.resolve.execute('u1', text)).resolves.toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id } });
    }
    expect(t.embedder.requests).toEqual([]);
    expect(t.events.map((e) => e.status)).toEqual(['matched', 'matched', 'matched']);
  });

  it('auto-matches the nearest topic at 0.88 or above, embedding the learner text as a query', async () => {
    const t = setup();
    t.embedder.queries.set('Learning hooks in React', at(similarityAngle(0.9)));

    const view = await t.resolve.execute('u1', '  Learning   hooks in React ');

    expect(view).toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id } });
    expect(t.embedder.requests).toEqual([expect.objectContaining({ stage: 'topic-resolve', kind: 'query', texts: ['Learning hooks in React'] })]);
  });

  it('offers nearest-first choices with similarity between 0.75 and 0.88', async () => {
    const t = setup();
    // 0.85 to React hooks (angle 0) and ~0.80 to React (angle 1.2); Vue is far below 0.75.
    t.embedder.queries.set('frontend state', at(similarityAngle(0.85)));

    const view = await t.resolve.execute('u1', 'frontend state');

    expect(view.status).toBe('choices');
    if (view.status !== 'choices') throw new Error('expected choices');
    expect(view.choices.map((c) => c.id)).toEqual([t.topics.hooks.id, t.topics.react.id]);
    expect(view.choices[0]?.similarity).toBe(0.85);
    expect(view.choices.every((c) => c.similarity >= 0.75 && c.similarity < 0.88)).toBe(true);
    expect(view.choices.length).toBeLessThanOrEqual(3);
    expect(t.events[0]).toMatchObject({ status: 'choices', topicId: null });
  });

  it('creates a normalised topic with an embedding below 0.75', async () => {
    const t = setup();

    const view = await t.resolve.execute('u1', 'how to bake sourdough at home');

    expect(view).toMatchObject({ status: 'created', topic: { canonicalName: 'Sourdough baking', aliases: ['sourdough'] } });
    const created = [...t.repo.topics.values()].find((x) => x.slug === 'sourdough-baking');
    expect(created).toMatchObject({ createdBy: 'u1', needsReview: false, embedding: { model: MODEL.model } });
    expect(t.embedder.requests[1]).toMatchObject({
      stage: 'topic-create',
      kind: 'document',
      titles: ['Sourdough baking'],
      texts: ['Sourdough baking. Also known as: sourdough. Baking bread with a wild yeast starter.'],
    });
    expect(t.events[0]).toMatchObject({ status: 'created', needsReview: false });
  });

  it('returns the existing topic when the normalised name is already in the catalog', async () => {
    const t = setup();
    t.normalizer.result = { canonicalName: 'React hooks', domain: 'software', description: 'x', aliases: [] };

    await expect(t.resolve.execute('u1', 'reactjs hookz')).resolves.toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id } });
    expect(t.repo.topics.size).toBe(3);
  });

  it('creates from the learner text, flagged for review, when the budget is spent or Haiku fails', async () => {
    for (const cause of ['budget', 'failure'] as const) {
      const t = setup();
      if (cause === 'budget') t.exceedBudget();
      else t.normalizer.fail = true;

      const view = await t.resolve.execute('u1', '  knitting   socks ');

      expect(view).toMatchObject({ status: 'created', topic: { canonicalName: 'Knitting socks', aliases: [], description: null } });
      expect([...t.repo.topics.values()].find((x) => x.slug === 'knitting-socks')?.needsReview).toBe(true);
      expect(t.normalizer.calls).toEqual(cause === 'budget' ? [] : ['  knitting   socks ']);
      expect(t.events[0]).toMatchObject({ status: 'created', needsReview: true });
    }
  });

  it('still creates the topic when its document embedding fails; the backfill embeds it later', async () => {
    const t = setup();
    t.embedder.failDocuments = true;

    await expect(t.resolve.execute('u1', 'sourdough')).resolves.toMatchObject({ status: 'created' });
    expect([...t.repo.topics.values()].find((x) => x.slug === 'sourdough-baking')?.embedding).toBeNull();
  });

  it(`caps new topics at ${DAILY_TOPIC_CREATE_LIMIT} per learner per UTC day, with Retry-After to midnight`, async () => {
    jest.useFakeTimers({ now: new Date('2026-10-22T23:59:30Z') });
    try {
      const t = setup();
      for (let i = 0; i < DAILY_TOPIC_CREATE_LIMIT; i++) t.repo.add({ slug: `mine-${i}`, canonicalName: `Mine ${i}`, createdBy: 'u1' });

      const error = await t.resolve.execute('u1', 'pottery').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TopicCreateLimitError);
      expect((error as TopicCreateLimitError).retryAfterSeconds).toBe(30);
      // Matches are never capped, and other learners are unaffected.
      await expect(t.resolve.execute('u1', 'hooks')).resolves.toMatchObject({ status: 'matched' });
      await expect(t.resolve.execute('u2', 'pottery')).resolves.toMatchObject({ status: 'created' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls through to vector search when an alias is shared by two topics', async () => {
    const t = setup();
    t.repo.add({ slug: 'react-native', canonicalName: 'React Native', aliases: ['hooks'] });
    t.embedder.queries.set('hooks', at(0.01));

    await expect(t.resolve.execute('u1', 'hooks')).resolves.toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id } });
    expect(t.embedder.requests).toHaveLength(1);
  });

  it('rejects text with nothing left after normalising', async () => {
    await expect(setup().resolve.execute('u1', '?!')).rejects.toBeInstanceOf(TopicTextInvalidError);
  });
});
