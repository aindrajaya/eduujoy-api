import { Module } from '@nestjs/common';
import { EmbedTopics } from './application/embed-topics.usecase';
import { GetConceptMapQuery } from './application/get-concept-map.query';
import { CONCEPT_MAP_READER } from './application/ports/concept-map.reader';
import { DrizzleConceptMapReader } from './infrastructure/drizzle-concept-map.reader';
import { GetTopicProfileQuery } from './application/get-topic-profile.query';
import { GetTopicQuery } from './application/get-topic.query';
import { TOPIC_NORMALIZER } from './application/ports/topic-normalizer';
import { TOPIC_REPOSITORY } from './application/ports/topic.repository';
import { ResolveTopic } from './application/resolve-topic.usecase';
import { DrizzleTopicRepository } from './infrastructure/drizzle-topic.repository';
import { HaikuTopicNormalizer } from './infrastructure/haiku-topic-normalizer';
import { TopicsController } from './interface/topics.controller';
import { ACCOUNT_DATA } from '../../shared/common/account';
import { DrizzleTopicBanks, TOPIC_BANKS } from '../../shared/common/topic-banks';
import { CatalogAccountData } from './infrastructure/catalog-account-data';

/** Catalog (PRD-API §4): topic lookups, resolution with embeddings (FR-01, FR-02) and the embedding backfill. */
@Module({
  controllers: [TopicsController],
  providers: [
    GetTopicQuery,
    GetTopicProfileQuery,
    GetConceptMapQuery,
    ResolveTopic,
    EmbedTopics,
    { provide: TOPIC_REPOSITORY, useClass: DrizzleTopicRepository },
    { provide: CONCEPT_MAP_READER, useClass: DrizzleConceptMapReader },
    { provide: TOPIC_NORMALIZER, useClass: HaikuTopicNormalizer },
    { provide: TOPIC_BANKS, useClass: DrizzleTopicBanks },
    { provide: ACCOUNT_DATA.catalog, useClass: CatalogAccountData },
  ],
  exports: [GetTopicQuery, GetTopicProfileQuery, GetConceptMapQuery, EmbedTopics, ACCOUNT_DATA.catalog],
})
export class CatalogModule {}
