import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type ConceptMap, conceptMatches, namesNearStage } from '../../../shared/common/concept-map';
import { GetConceptMapQuery } from '../../catalog/application/get-concept-map.query';
import { type ServeDrop, servedCards, type ServePreference, type Stage } from '../domain';
import { CARD_READER, type CardReader, type PoolSnapshot, type ServedCard } from './ports/card.reader';

/** Where the serving rules get a topic's concept map: the catalog query, or a stand-in in scripts. */
export interface ConceptMapSource {
  execute(topicId: string): Promise<ConceptMap | null>;
}

export interface ServedPool {
  pool: PoolSnapshot | null;
  cards: ServedCard[];
  /** Cards the serving rules held back (domain serving-rules), and whether the pool was refilled. */
  held?: { dropped: Record<ServeDrop, number>; refilled: number; formatRefilled: number; flagged: boolean };
}

/**
 * What pathing (A9) reads from discovery: a topic and stage's latest pool with its live served cards
 * (the designer's input), and the cards a saved path cites (GET /v1/paths/{id}). The serving rules
 * (A8 follow-up, user 3 Nov 2026) decide which analysed cards a pool serves; nothing is deleted.
 */
@Injectable()
export class ServedCardsQuery {
  private readonly logger = new Logger(ServedCardsQuery.name);

  constructor(
    @Inject(CARD_READER) private readonly reader: CardReader,
    @Optional() @Inject(GetConceptMapQuery) private readonly maps: ConceptMapSource | null = null,
  ) {}

  /** `prefer`: the learner's usable cards (pathing), so their format is refilled first when short. */
  async pool(topicId: string, stage: Stage, prefer?: ServePreference<ServedCard>): Promise<ServedPool> {
    const pool = await this.reader.latestPool(topicId, stage);
    if (!pool || pool.status === 'analysing') return { pool, cards: [] };
    const all = await this.reader.cards(topicId, pool.resourceIds, false);
    const map = this.maps ? await this.maps.execute(topicId) : null;
    const out = servedCards(all, stage, map ? namesNearStage(map, stage) : null, conceptMatches, prefer);
    if (out.flagged) this.logger.warn({ topicId, stage, poolId: pool.id, kept: out.cards.length, refilled: out.refilled, formatRefilled: out.formatRefilled }, 'Pool refilled after the serving rules');
    return { pool, cards: out.cards, held: { dropped: out.dropped, refilled: out.refilled, formatRefilled: out.formatRefilled, flagged: out.flagged } };
  }

  /** A saved path's resources, dead ones included (A11 swaps those; the path still shows them). No serving rules: a path keeps what it cited. */
  cited(topicId: string, resourceIds: string[]): Promise<ServedCard[]> {
    return this.reader.cards(topicId, resourceIds, true);
  }
}
