import { type ServedCard } from '../../discovery/application/ports/card.reader';
import { coreConcepts, MIN_FORMAT_CARDS, selectCards } from './select-cards';

const card = (n: number, over: Partial<ServedCard> = {}): ServedCard => ({
  resourceId: `r${n}`,
  type: 'article',
  url: `https://example.com/${n}`,
  youtubeId: null,
  title: `R${n}`,
  source: 'example.com',
  durationMin: null,
  readingMin: 10,
  published: null,
  language: 'en',
  stage: 'novice',
  bloomLevels: ['C1'],
  prerequisites: [],
  concepts: [],
  keyTakeaways: [],
  whyThis: null,
  quality: { relevance: 80, accuracySignals: 80, recency: 80, teaching: 80 },
  qualityScore: 80,
  ...over,
});

describe('selectCards (v2, after check (c))', () => {
  it('keeps only cards in the path language', () => {
    const out = selectCards([card(1), card(2, { language: 'id' }), card(3, { language: 'EN' })], { language: 'en', formats: [], stepMax: 90 });
    expect(out).toEqual({ cards: [card(1), card(3, { language: 'EN' })], formatFallback: false, droppedForLanguage: 1, droppedTooLong: 0, droppedStubs: 0 });
  });

  it(`honours the preferred formats when at least ${MIN_FORMAT_CARDS} cards match`, () => {
    const pool = [card(1, { type: 'youtube' }), card(2, { type: 'youtube' }), card(3, { type: 'youtube' }), card(4), card(5, { type: 'paper' })];
    expect(selectCards(pool, { language: 'en', formats: ['video'], stepMax: 90 }).cards.map((c) => c.resourceId)).toEqual(['r1', 'r2', 'r3']);
    // text means article, official docs and related pages.
    expect(selectCards([card(1), card(2, { type: 'official_doc' }), card(3, { type: 'related' }), card(4, { type: 'youtube' })], { language: 'en', formats: ['text'], stepMax: 90 }).cards).toHaveLength(3);
  });

  it('falls back to every format, flagged, when too few match', () => {
    const out = selectCards([card(1, { type: 'youtube' }), card(2), card(3)], { language: 'en', formats: ['video'], stepMax: 90 });
    expect(out).toMatchObject({ formatFallback: true });
    expect(out.cards).toHaveLength(3);
  });
});

describe('selectCards and the step cap (lead, 3 Nov 2026)', () => {
  const chapters = [{ name: 'Part 1', start: '0:00', end: '20:00' }];
  const video = (n: number, durationMin: number, over: Partial<ServedCard> = {}) => card(n, { type: 'youtube', durationMin, readingMin: null, ...over });

  it('leaves out texts longer than one step, and long videos only when they have no timed chapters to split by', () => {
    const out = selectCards([card(1, { readingMin: 50 }), card(2, { readingMin: 45 }), video(3, 120, { concepts: chapters }), video(4, 120), video(5, 40)], { language: 'en', formats: [], stepMax: 45 });
    expect(out.cards.map((c) => c.resourceId)).toEqual(['r2', 'r3', 'r5']);
    expect(out.droppedTooLong).toBe(2);
    // Untimed chapters can't be pointed at.
    expect(selectCards([video(1, 120, { concepts: [{ name: 'Part', start: null, end: null }] })], { language: 'en', formats: [], stepMax: 90 }).cards).toEqual([]);
  });

  it('drops docs and related pages under 3 minutes as stubs, but not short articles or unknown lengths', () => {
    const out = selectCards(
      [card(1, { type: 'official_doc', readingMin: 2 }), card(2, { type: 'related', readingMin: 1 }), card(3, { type: 'official_doc', readingMin: 3 }), card(4, { readingMin: 1 }), card(5, { type: 'related', readingMin: null })],
      { language: 'en', formats: [], stepMax: 90 },
    );
    expect(out.cards.map((c) => c.resourceId)).toEqual(['r3', 'r4', 'r5']);
    expect(out.droppedStubs).toBe(2);
  });
});

describe('coreConcepts (denoised, lead 2 Nov 2026)', () => {
  const named = (n: number, names: string[], stage: ServedCard['stage'] = 'novice') => card(n, { stage, concepts: names.map((name) => ({ name, start: null, end: null })) });
  const novice = { stages: ['novice'], target: 'novice' };

  it('ranks concepts taught by at least 2 cards, most common first, case-insensitively', () => {
    const cards = [named(1, ['Loops', 'Variables', 'A', 'B']), named(2, ['variables', 'Lists', 'Loops', 'A', 'B']), named(3, ['Variables', 'Variables', 'Tuples'])];
    expect(coreConcepts(cards, novice)).toEqual(['Variables', 'Loops', 'A', 'B']);
    expect(coreConcepts([named(1, ['A', 'B']), named(2, ['A', 'B'])], novice, 1)).toEqual(['A']);
  });

  it('fills up to 4 from single-card concepts when few are shared, most common first', () => {
    const cards = [named(1, ['Loops', 'Variables']), named(2, ['variables', 'Lists']), named(3, ['Tuples'])];
    expect(coreConcepts(cards, novice)).toEqual(['Variables', 'Loops', 'Lists', 'Tuples']);
    expect(coreConcepts([named(1, ['Only'])], novice)).toEqual(['Only']);
  });

  it("counts only cards of the path's own stages", () => {
    const cards = [named(1, ['Joins'], 'competent'), named(2, ['Joins'], 'expert'), named(3, ['Joins'], 'competent'), named(4, ['Window functions'], 'expert'), named(5, ['Window functions'], 'expert')];
    // Window functions are taught only by expert cards, outside the path's stages.
    expect(coreConcepts(cards, { stages: ['competent', 'proficient'], target: 'proficient' })).toEqual(['Joins']);
  });

  it('drops meta terms, and OOP terms for a novice-band path only', () => {
    const cards = [named(1, ['Installation', 'Classes', 'API Reference', 'Loops']), named(2, ['installation', 'Classes', 'API reference', 'Loops'])];
    expect(coreConcepts(cards, novice)).toEqual(['Loops']);
    const competent = cards.map((c) => ({ ...c, stage: 'competent' as const }));
    expect(coreConcepts(competent, { stages: ['competent'], target: 'proficient' })).toEqual(['Classes', 'Loops']);
  });
});
