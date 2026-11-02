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
    const out = selectCards([card(1), card(2, { language: 'id' }), card(3, { language: 'EN' })], { language: 'en', formats: [] });
    expect(out).toEqual({ cards: [card(1), card(3, { language: 'EN' })], formatFallback: false, droppedForLanguage: 1 });
  });

  it(`honours the preferred formats when at least ${MIN_FORMAT_CARDS} cards match`, () => {
    const pool = [card(1, { type: 'youtube' }), card(2, { type: 'youtube' }), card(3, { type: 'youtube' }), card(4), card(5, { type: 'paper' })];
    expect(selectCards(pool, { language: 'en', formats: ['video'] }).cards.map((c) => c.resourceId)).toEqual(['r1', 'r2', 'r3']);
    // text means article, official docs and related pages.
    expect(selectCards([card(1), card(2, { type: 'official_doc' }), card(3, { type: 'related' }), card(4, { type: 'youtube' })], { language: 'en', formats: ['text'] }).cards).toHaveLength(3);
  });

  it('falls back to every format, flagged, when too few match', () => {
    const out = selectCards([card(1, { type: 'youtube' }), card(2), card(3)], { language: 'en', formats: ['video'] });
    expect(out).toMatchObject({ formatFallback: true });
    expect(out.cards).toHaveLength(3);
  });
});

describe('coreConcepts', () => {
  it('ranks the cards’ concepts by how many cards teach them, then first seen, case-insensitively', () => {
    const named = (n: number, names: string[]) => card(n, { concepts: names.map((name) => ({ name, start: null, end: null })) });
    expect(coreConcepts([named(1, ['Loops', 'Variables']), named(2, ['variables', 'Lists']), named(3, ['Variables', 'Variables'])])).toEqual(['Variables', 'Loops', 'Lists']);
    expect(coreConcepts([named(1, ['A', 'B', 'C'])], 2)).toEqual(['A', 'B']);
  });
});
