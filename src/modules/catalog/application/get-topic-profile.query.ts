import { Inject, Injectable } from '@nestjs/common';
import { TOPIC_REPOSITORY, type TopicProfile, type TopicRepository } from './ports/topic.repository';

export { type TopicProfile } from './ports/topic.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A topic with its domain, for modules that build on it (discovery). Not a public HTTP shape. */
@Injectable()
export class GetTopicProfileQuery {
  constructor(@Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository) {}

  /** Null for unknown or malformed ids. */
  execute(id: string): Promise<TopicProfile | null> {
    return UUID.test(id) ? this.topics.findProfile(id) : Promise.resolve(null);
  }
}
