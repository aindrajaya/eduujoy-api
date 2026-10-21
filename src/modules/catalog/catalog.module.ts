import { Module } from '@nestjs/common';
import { GetTopicQuery } from './application/get-topic.query';
import { TOPIC_REPOSITORY } from './application/ports/topic.repository';
import { DrizzleTopicRepository } from './infrastructure/drizzle-topic.repository';

/** Catalog (PRD-API §4). A7 needs topic lookups; A6 adds resolution with embeddings. */
@Module({
  providers: [GetTopicQuery, { provide: TOPIC_REPOSITORY, useClass: DrizzleTopicRepository }],
  exports: [GetTopicQuery],
})
export class CatalogModule {}
