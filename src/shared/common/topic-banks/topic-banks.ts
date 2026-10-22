import { Inject, Injectable } from '@nestjs/common';
import { and, inArray, ne } from 'drizzle-orm';
import { DATABASE, type Database } from '../../db';
import { diagnosticItems } from '../../db/schema/assessment';

export const TOPIC_BANKS = Symbol('TopicBanks');

/** Which topics have a diagnostic item bank (contract 0.9.0 `Topic.hasDiagnostic`). */
export interface TopicBanks {
  /** The ids among `topicIds` with at least one servable diagnostic item; one query per call. */
  withBank(topicIds: readonly string[]): Promise<Set<string>>;
}

/**
 * Shared because catalog serialises topics but assessment owns the items; modules may not read each
 * other's tables. Counts the items the diagnostic can serve (short answers are never served).
 */
@Injectable()
export class DrizzleTopicBanks implements TopicBanks {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async withBank(topicIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(topicIds)];
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ topicId: diagnosticItems.topicId })
      .from(diagnosticItems)
      .where(and(inArray(diagnosticItems.topicId, ids), ne(diagnosticItems.kind, 'short_answer')));
    return new Set(rows.map((r) => r.topicId));
  }
}
