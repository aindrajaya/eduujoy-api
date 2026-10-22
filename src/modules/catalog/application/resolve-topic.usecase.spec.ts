import { EventEmitter2 } from '@nestjs/event-emitter';
import { type AiBudgetGuard, AiBudgetExceededError, type Embedder, type EmbeddingRequest } from '../../../shared/ai';
import { EventBus } from '../../../shared/events/event-bus';
import { type TopicResolved } from '../domain/events/topic-resolved.event';
import { CHOICE_THRESHOLD, MATCH_THRESHOLD } from '../domain/resolution';
import { FakeTopicBanks, FakeTopicRepository } from './catalog.fakes';
import { TopicCreateLimitError, TopicSearchUnavailableError, TopicTextInvalidError } from './errors';
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
  failQueries = false;

  embed(request: EmbeddingRequest) {
    this.requests.push(request);
    if (request.kind === 'document' && this.failDocuments) return Promise.reject(new Error('gemini down'));
    if (request.kind === 'query' && this.failQueries) return Promise.reject(new Error('gemini down'));
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
  const react = repo.add({ slug: 'react', canonicalName: 'React', embedding: { vector: at(1.645), ...MODEL } });
  const vue = repo.add({ slug: 'vue', canonicalName: 'Vue', embedding: { vector: at(-1.2), ...MODEL } });
  const banks = new FakeTopicBanks();
  return {
    repo,
    embedder,
    normalizer,
    banks,
    events,
    topics: { hooks, react, vue },
    exceedBudget: () => {
      budgetExceeded = true;
    },
    resolve: new ResolveTopic(repo, embedder, normalizer, banks, budget, bus),
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

  it('auto-matches the nearest topic at the match threshold or above, embedding the learner text as a query', async () => {
    const t = setup();
    t.embedder.queries.set('Learning hooks in React', at(similarityAngle(0.75)));

    const view = await t.resolve.execute('u1', '  Learning   hooks in React ');

    expect(view).toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id } });
    expect(t.embedder.requests).toEqual([expect.objectContaining({ stage: 'topic-resolve', kind: 'query', texts: ['Learning hooks in React'] })]);
  });

  it('offers nearest-first choices with similarity between the thresholds', async () => {
    const t = setup();
    // 0.69 to React hooks (angle 0) and 0.67 to React (angle 1.645); Vue (angle -1.2) is far below.
    t.embedder.queries.set('frontend state', at(similarityAngle(0.69)));

    const view = await t.resolve.execute('u1', 'frontend state');

    expect(view.status).toBe('choices');
    if (view.status !== 'choices') throw new Error('expected choices');
    expect(view.choices.map((c) => c.id)).toEqual([t.topics.hooks.id, t.topics.react.id]);
    expect(view.choices[0]?.similarity).toBe(0.69);
    expect(view.choices.every((c) => c.similarity >= CHOICE_THRESHOLD && c.similarity < MATCH_THRESHOLD)).toBe(true);
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

  it("never shows a learner another learner's flagged topic, and gives them their own", async () => {
    const t = setup();
    t.normalizer.fail = true;
    const first = await t.resolve.execute('u1', 'knitting socks');
    t.embedder.queries.set('knitting socks', at(3));

    const second = await t.resolve.execute('u2', 'knitting socks');
    const own = await t.resolve.execute('u1', 'knitting socks');

    expect(second.status).toBe('created');
    expect(second.status === 'created' && first.status === 'created' && second.topic.id !== first.topic.id).toBe(true);
    expect([...t.repo.topics.values()].filter((x) => x.slug.startsWith('knitting-socks')).map((x) => x.slug).sort()).toEqual(['knitting-socks', 'knitting-socks-2']);
    expect(own).toMatchObject({ status: 'matched', topic: { id: first.status === 'created' ? first.topic.id : '' } });
  });

  it('rejects a create that loses the race to the cap after passing the pre-check', async () => {
    const t = setup();
    for (let i = 0; i < DAILY_TOPIC_CREATE_LIMIT; i++) t.repo.add({ slug: `mine-${i}`, canonicalName: `Mine ${i}`, createdBy: 'u1' });
    // A parallel request created the last topics between the pre-check and the insert.
    t.repo.countCreatedBy = () => Promise.resolve(0);

    await expect(t.resolve.execute('u1', 'pottery')).rejects.toBeInstanceOf(TopicCreateLimitError);
    expect([...t.repo.topics.values()].filter((x) => x.createdBy === 'u1')).toHaveLength(DAILY_TOPIC_CREATE_LIMIT);
  });

  it('falls through to vector search when an alias is shared by two topics', async () => {
    const t = setup();
    t.repo.add({ slug: 'react-native', canonicalName: 'React Native', aliases: ['hooks'] });
    t.embedder.queries.set('hooks', at(0.01));

    await expect(t.resolve.execute('u1', 'hooks')).resolves.toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id } });
    expect(t.embedder.requests).toHaveLength(1);
  });

  it('falls back to name search during an embedding outage, offering close names as choices', async () => {
    const t = setup();
    t.embedder.failQueries = true;
    t.repo.nameScores.set('react-hooks', 0.62).set('react', 0.41).set('vue', 0.1);

    const view = await t.resolve.execute('u1', 'reakt hookz');

    expect(view).toEqual({ status: 'choices', choices: [expect.objectContaining({ id: t.topics.hooks.id, similarity: 0.62 }), expect.objectContaining({ id: t.topics.react.id, similarity: 0.41 })] });
    expect(t.normalizer.calls).toEqual([]);
  });

  it('answers 503 with Retry-After 30 during an outage when no name is close, and creates nothing', async () => {
    const t = setup();
    t.embedder.failQueries = true;

    const error = await t.resolve.execute('u1', 'sourdough baking').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TopicSearchUnavailableError);
    expect((error as TopicSearchUnavailableError).retryAfterSeconds).toBe(30);
    expect(t.repo.topics.size).toBe(3);
    expect(t.events).toEqual([]);
  });

  it('carries the method and top two similarities on TopicResolved for re-tuning', async () => {
    const t = setup();
    t.embedder.queries.set('frontend state', at(similarityAngle(0.69)));

    await t.resolve.execute('u1', 'hooks');
    await t.resolve.execute('u1', 'frontend state');

    expect(t.events[0]).toMatchObject({ method: 'exact', topSimilarity: 1, secondSimilarity: null });
    expect(t.events[1]).toMatchObject({ method: 'vector', topSimilarity: 0.69, secondSimilarity: expect.closeTo(0.67, 2) as unknown });
  });

  describe('createNew (contract 0.5.0)', () => {
    it('skips matching and creates from the text, even when it would offer choices', async () => {
      const t = setup();
      t.embedder.queries.set('frontend state', at(similarityAngle(0.69)));
      t.normalizer.result = { canonicalName: 'Frontend state management', domain: 'software', description: 'State in UIs.', aliases: [] };

      const view = await t.resolve.execute('u1', 'frontend state', { createNew: true });

      expect(view).toMatchObject({ status: 'created', topic: { canonicalName: 'Frontend state management' } });
      // No matching, but one query embedding for `related` (contract 0.9.0), then the new topic's document.
      expect(t.embedder.requests.map((r) => r.kind)).toEqual(['query', 'document']);
      expect(t.events[0]).toMatchObject({ status: 'created', method: 'create_new', topSimilarity: null });
    });

    it('still returns an existing visible topic instead of a duplicate, and keeps the daily cap', async () => {
      const t = setup();
      t.normalizer.result = { canonicalName: 'React hooks', domain: 'software', description: 'x', aliases: [] };
      await expect(t.resolve.execute('u1', 'hookz in react', { createNew: true })).resolves.toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id } });

      for (let i = 0; i < DAILY_TOPIC_CREATE_LIMIT; i++) t.repo.add({ slug: `mine-${i}`, canonicalName: `Mine ${i}`, createdBy: 'u1' });
      await expect(t.resolve.execute('u1', 'pottery', { createNew: true })).rejects.toBeInstanceOf(TopicCreateLimitError);
    });
  });

  it('rejects text with nothing left after normalising', async () => {
    await expect(setup().resolve.execute('u1', '?!')).rejects.toBeInstanceOf(TopicTextInvalidError);
  });

  describe('contract 0.9.0: hasDiagnostic and domain-filtered related', () => {
    /** Prod 22 Oct 2026: "Indonesian language" had Spanish 0.679, Java 0.667, English grammar 0.651 nearest. */
    function indonesian() {
      const t = setup();
      // The query sits at angle 3, far from the React fixtures; each topic at its prod similarity to it.
      const Q = 3;
      const place = (slug: string, canonicalName: string, domain: 'software' | 'non_technical', similarity: number) =>
        t.repo.add({ slug, canonicalName, domain, embedding: { vector: at(Q - similarityAngle(similarity)), ...MODEL } });
      const spanish = place('spanish', 'Spanish', 'non_technical', 0.679);
      const java = place('java', 'Java', 'software', 0.667);
      const grammar = place('english-grammar', 'English grammar', 'non_technical', 0.651);
      const weak = place('public-speaking', 'Public speaking', 'non_technical', 0.55);
      t.embedder.queries.set('Indonesian language', at(Q));
      t.normalizer.result = { canonicalName: 'Indonesian language', domain: 'non_technical', description: 'The Indonesian language.', aliases: ['bahasa indonesia'] };
      t.banks.banked.add(spanish.id).add(java.id);
      return { t, spanish, java, grammar, weak };
    }

    it('suggests same-domain topics above the floor, banked first, never Java (createNew)', async () => {
      const { t, spanish, grammar } = indonesian();

      const view = await t.resolve.execute('u1', 'Indonesian language', { createNew: true });

      expect(view.status).toBe('created');
      if (view.status !== 'created') return;
      expect(view.related.map((r) => r.canonicalName)).toEqual(['Spanish', 'English grammar']);
      expect(view.related).toEqual([expect.objectContaining({ id: spanish.id, hasDiagnostic: true }), expect.objectContaining({ id: grammar.id, hasDiagnostic: false })]);
      expect(view.topic.hasDiagnostic).toBe(false);
      // One bank lookup for the whole response.
      expect(t.banks.lookups).toHaveLength(1);
    });

    it("falls back to the nearest neighbour's domain at 0.65 when the normaliser is unavailable", async () => {
      const { t } = indonesian();
      t.normalizer.fail = true;

      const view = await t.resolve.execute('u1', 'Indonesian language', { createNew: true });

      // Spanish (0.679) passes the stricter floor; English grammar (0.651) does too, just.
      expect(view.status === 'created' ? view.related.map((r) => r.canonicalName) : null).toEqual(['Spanish', 'English grammar']);
    });

    it('suggests nothing for "beekeeping" without a normaliser domain, never react-hooks', async () => {
      const t = setup();
      const Q = 3;
      t.repo.add({ slug: 'react-hooks-2', canonicalName: 'React hooks (software)', domain: 'software', embedding: { vector: at(Q - similarityAngle(0.618)), ...MODEL } });
      t.repo.add({ slug: 'observability', canonicalName: 'Observability', domain: 'software', embedding: { vector: at(Q - similarityAngle(0.614)), ...MODEL } });
      t.repo.add({ slug: 'cooking', canonicalName: 'Cooking', domain: 'non_technical', embedding: { vector: at(Q + similarityAngle(0.6)), ...MODEL } });
      t.embedder.queries.set('beekeeping', at(Q));
      t.normalizer.fail = true;

      const view = await t.resolve.execute('u1', 'beekeeping', { createNew: true });

      expect(view).toMatchObject({ status: 'created', related: [] });
    });

    it('returns no related topics when none reaches the floor', async () => {
      const t = setup();
      t.embedder.queries.set('beekeeping', at(Math.PI));

      const view = await t.resolve.execute('u1', 'beekeeping');

      expect(view).toMatchObject({ status: 'created', related: [] });
    });

    it('marks matched topics and every choice with hasDiagnostic', async () => {
      const t = setup();
      t.banks.banked.add(t.topics.hooks.id);
      t.embedder.queries.set('state in function components', at(0.05));

      await expect(t.resolve.execute('u1', 'React Hooks')).resolves.toMatchObject({ status: 'matched', topic: { id: t.topics.hooks.id, hasDiagnostic: true } });
      t.embedder.queries.set('react or hooks', at(0.8225));
      const view = await t.resolve.execute('u1', 'react or hooks');
      expect(view.status).toBe('choices');
      if (view.status === 'choices') for (const c of view.choices) expect(c.hasDiagnostic).toBe(c.id === t.topics.hooks.id);
    });
  });
});

