export const TOPIC_REPOSITORY = Symbol('TopicRepository');

/** Contract schema Topic. */
export interface TopicView {
  id: string;
  canonicalName: string;
  aliases: string[];
  parentId: string | null;
  description: string | null;
}

export interface TopicRepository {
  findById(id: string): Promise<TopicView | null>;
}
