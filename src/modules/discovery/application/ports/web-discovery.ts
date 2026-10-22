import { type BudgetScope } from '../../../../shared/ai';
import { type Stage, type TopicDomain, type WebResourceType } from '../../domain';

export const WEB_DISCOVERY = Symbol('WebDiscovery');

export interface DiscoveryTopic {
  id: string;
  name: string;
  description: string | null;
  domain: TopicDomain | null;
}

/** A page the web search returned; never search prose or `encrypted_content` (PRD-API §11). */
export interface WebFind {
  url: string;
  title: string;
  pageAge: string | null;
  type: WebResourceType;
}

/** Claude web search for articles, official docs and Medium posts (`WebDiscovery` in PRD-API §11). */
export interface WebDiscovery {
  /**
   * `includeVideos` asks for YouTube videos too: the fallback when the YouTube `search.list` guard is
   * reached (master PRD §14). Video results are recognised by URL and confirmed with `videos.list`.
   */
  find(input: { topic: DiscoveryTopic; stage: Stage; max: number; includeVideos: boolean; jobId?: string; budgetScope?: BudgetScope; signal?: AbortSignal }): Promise<WebFind[]>;
}
