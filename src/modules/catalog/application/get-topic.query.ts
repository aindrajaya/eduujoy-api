import { Inject, Injectable } from '@nestjs/common';
import { TOPIC_REPOSITORY, type TopicRepository, type TopicView } from './ports/topic.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public catalog query (other modules look topics up through this, never through the tables). */
@Injectable()
export class GetTopicQuery {
  constructor(@Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository) {}

  /** Null for unknown or malformed ids. */
  execute(id: string): Promise<TopicView | null> {
    return UUID.test(id) ? this.topics.findById(id) : Promise.resolve(null);
  }
}
