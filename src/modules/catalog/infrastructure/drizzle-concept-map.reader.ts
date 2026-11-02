import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type ConceptMap, conceptMapSchema } from '../../../shared/common/concept-map';
import { DATABASE, type Database } from '../../../shared/db';
import { topicConceptMaps } from '../../../shared/db/schema/catalog';
import { type ConceptMapReader } from '../application/ports/concept-map.reader';

@Injectable()
export class DrizzleConceptMapReader implements ConceptMapReader {
  private readonly logger = new Logger(DrizzleConceptMapReader.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async forTopic(topicId: string): Promise<ConceptMap | null> {
    const [row] = await this.db.select({ map: topicConceptMaps.map }).from(topicConceptMaps).where(eq(topicConceptMaps.topicId, topicId));
    if (!row) return null;
    const parsed = conceptMapSchema.safeParse(row.map);
    // A stored map that no longer parses is treated as missing: the path is designed without it.
    if (!parsed.success) this.logger.warn({ topicId }, 'Stored concept map does not parse; ignored');
    return parsed.success ? parsed.data : null;
  }
}
