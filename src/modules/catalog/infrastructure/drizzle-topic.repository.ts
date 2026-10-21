import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { topics } from '../../../shared/db/schema/catalog';
import { type TopicRepository, type TopicView } from '../application/ports/topic.repository';

@Injectable()
export class DrizzleTopicRepository implements TopicRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string): Promise<TopicView | null> {
    const [row] = await this.db
      .select({
        id: topics.id,
        canonicalName: topics.canonicalName,
        aliases: topics.aliases,
        parentId: topics.parentId,
        description: topics.description,
      })
      .from(topics)
      .where(eq(topics.id, id));
    return row ?? null;
  }
}
