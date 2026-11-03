import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CardReader, type PoolSnapshot, type ServedCard } from '../../discovery/application/ports/card.reader';
import { ServedCardsQuery } from '../../discovery/application/served-cards.query';
import { conceptMapSchema } from '../../../shared/common/concept-map';
import { stepMaxMinutes } from '../domain';
import { selectCards, usableInPreferredFormat } from './select-cards';

const ROOT = join(__dirname, '..', '..', '..', '..');
// Real cards: public-speaking's novice pool on dev ep-noisy-mouse after the A8 pilot rebuild (4 Nov 2026).
const fixture = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'discovery', 'public-speaking-pe020-cards.json'), 'utf8')) as { novice: ServedCard[] };
const map = conceptMapSchema.parse(JSON.parse(readFileSync(join(ROOT, 'seed', 'concept-maps', 'public-speaking.json'), 'utf8')));

function query(cards: ServedCard[]): ServedCardsQuery {
  const pool: PoolSnapshot = { id: 'p', status: 'ready', poolVersion: 2, expiresAt: new Date(Date.now() + 86_400_000), candidates: cards.length, analysed: cards.length, resourceIds: cards.map((c) => c.resourceId) };
  const reader: CardReader = { latestPool: () => Promise.resolve(pool), cards: () => Promise.resolve(cards) };
  return new ServedCardsQuery(reader, { execute: () => Promise.resolve(map) });
}

describe("refill the learner's format first (lead, 4 Nov 2026; the real pe-020 case)", () => {
  // pe-020: a novice who wants text only, 6 h a week; novice is also the target, so only this pool.
  const learner = { language: 'en', formats: ['text' as const], stepMax: stepMaxMinutes(6) };

  it('without the preference, the serving rules leave too few usable text cards and pathing falls back to every format', async () => {
    const { cards } = await query(fixture.novice).pool('t', 'novice');
    expect(selectCards(cards, learner)).toMatchObject({ formatFallback: true });
  });

  it('with it, an off-map text card comes back, so the learner gets at least 3 text cards and no fallback', async () => {
    const usable = usableInPreferredFormat(learner);
    if (!usable) throw new Error('expected a preference');
    const out = await query(fixture.novice).pool('t', 'novice', { usable });
    const selection = selectCards(out.cards, learner);
    expect(selection.formatFallback).toBe(false);
    expect(selection.cards.filter((c) => ['article', 'official_doc', 'related'].includes(c.type)).length).toBeGreaterThanOrEqual(3);
    expect(out.held).toMatchObject({ formatRefilled: 1, flagged: true });
    // The card that came back: held only as off-map, never a page kind or a low-relevance card.
    const back = out.cards.find((c) => c.title.startsWith('Speech and Communication - OER By Discipline'));
    expect(back?.quality.relevance).toBeGreaterThanOrEqual(70);
  });

  it('asks nothing of a learner with no format preference', () => {
    expect(usableInPreferredFormat({ ...learner, formats: [] })).toBeNull();
  });
});
