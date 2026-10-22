import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { type AccountDataContributor } from '../../../shared/common/account';
import { DATABASE, type Database } from '../../../shared/db';
import { topics } from '../../../shared/db/schema/catalog';

/** Topics the learner's text created. On deletion they stay in the catalog, unlinked (created_by set null). */
@Injectable()
export class CatalogAccountData implements AccountDataContributor {
  readonly section = 'topicsCreated';

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  export(userId: string): Promise<unknown> {
    return this.db
      .select({ id: topics.id, slug: topics.slug, canonicalName: topics.canonicalName, aliases: topics.aliases, description: topics.description, createdAt: topics.createdAt })
      .from(topics)
      .where(eq(topics.createdBy, userId))
      .orderBy(asc(topics.createdAt));
  }
}
