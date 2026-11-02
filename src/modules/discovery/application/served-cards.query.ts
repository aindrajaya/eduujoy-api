import { Inject, Injectable } from '@nestjs/common';
import { type Stage } from '../domain';
import { CARD_READER, type CardReader, type PoolSnapshot, type ServedCard } from './ports/card.reader';

/**
 * What pathing (A9) reads from discovery: a topic and stage's latest pool with its live served cards
 * (the designer's input), and the cards a saved path cites (GET /v1/paths/{id}).
 */
@Injectable()
export class ServedCardsQuery {
  constructor(@Inject(CARD_READER) private readonly reader: CardReader) {}

  async pool(topicId: string, stage: Stage): Promise<{ pool: PoolSnapshot | null; cards: ServedCard[] }> {
    const pool = await this.reader.latestPool(topicId, stage);
    if (!pool || pool.status === 'analysing') return { pool, cards: [] };
    return { pool, cards: await this.reader.cards(topicId, pool.resourceIds, false) };
  }

  /** A saved path's resources, dead ones included (A11 swaps those; the path still shows them). */
  cited(topicId: string, resourceIds: string[]): Promise<ServedCard[]> {
    return this.reader.cards(topicId, resourceIds, true);
  }
}
