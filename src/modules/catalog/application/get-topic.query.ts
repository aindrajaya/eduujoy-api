import { Inject, Injectable } from '@nestjs/common';
import { TOPIC_BANKS, type TopicBanks } from '../../../shared/common/topic-banks';
import { TOPIC_REPOSITORY, type TopicRepository, type TopicView } from './ports/topic.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public catalog query (other modules look topics up through this, never through the tables). */
@Injectable()
export class GetTopicQuery {
  constructor(
    @Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository,
    @Inject(TOPIC_BANKS) private readonly banks: TopicBanks,
  ) {}

  /** Null for unknown or malformed ids; `hasDiagnostic` set (contract 0.9.0). */
  async execute(id: string): Promise<TopicView | null> {
    if (!UUID.test(id)) return null;
    const topic = await this.topics.findById(id);
    if (!topic) return null;
    return { ...topic, hasDiagnostic: (await this.banks.withBank([topic.id])).has(topic.id) };
  }
}
