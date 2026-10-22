import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type BudgetScope, PromptRegistry, WEB_SEARCHER, type WebSearcher, wrapUntrusted } from '../../../shared/ai';
import { type DiscoveryTopic, type WebDiscovery, type WebFind } from '../application/ports/web-discovery';
import { BLOCKED_DOMAINS, normaliseUrl, officialDocRule, type Stage, type WebResourceType, youtubeIdFromUrl } from '../domain';

export const WEB_DISCOVERY_PROMPT = 'web-discovery';
/** PRD-API §11: at most 6 searches per discovery. */
export const MAX_SEARCHES = 6;

const answer = z.object({
  picks: z.array(z.object({ url: z.string().max(2_000), type: z.enum(['article', 'official_doc', 'related']) })).max(40),
});

const ARTICLE_HOSTS = /(^|\.)(medium\.com|dev\.to|substack\.com|hashnode\.dev|freecodecamp\.org)$/;

/** A result Claude didn't classify: blog platforms are articles, the rest related. */
function fallbackType(url: string): WebResourceType {
  return ARTICLE_HOSTS.test(new URL(url).hostname) ? 'article' : 'related';
}

/**
 * Claude Haiku with server-side web search (PRD-API §11). Only URLs the search actually returned are
 * kept, so the model cannot invent links; its picks order and type them. When its answer is missing or
 * invalid, the raw results are used, typed by host.
 */
@Injectable()
export class ClaudeWebDiscovery implements WebDiscovery {
  constructor(
    @Inject(WEB_SEARCHER) private readonly searcher: WebSearcher,
    private readonly prompts: PromptRegistry,
  ) {}

  async find(input: { topic: DiscoveryTopic; stage: Stage; max: number; includeVideos: boolean; jobId?: string; budgetScope?: BudgetScope; signal?: AbortSignal }): Promise<WebFind[]> {
    const request = [
      `Topic: ${input.topic.name}`,
      `Domain: ${input.topic.domain ?? 'unknown'} (official docs: ${officialDocRule(input.topic.domain)})`,
      `Learner stage: ${input.stage}`,
      `Return up to ${input.max} resources.`,
      input.includeVideos ? 'Include YouTube videos too (youtube.com/watch links).' : 'Do not include videos.',
      wrapUntrusted('topic-description', input.topic.description ?? ''),
    ].join('\n');
    const result = await this.searcher.search({
      stage: 'discover',
      model: 'claude-haiku-5-5',
      prompt: this.prompts.get(WEB_DISCOVERY_PROMPT),
      input: request,
      maxUses: MAX_SEARCHES,
      blockedDomains: [...BLOCKED_DOMAINS],
      maxTokens: 2_000,
      schema: answer,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.budgetScope ? { budgetScope: input.budgetScope } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const hits = new Map<string, (typeof result.hits)[number]>();
    for (const hit of result.hits) {
      const url = normaliseUrl(hit.url);
      if (url && !hits.has(url)) hits.set(url, hit);
    }
    const finds: WebFind[] = [];
    const seen = new Set<string>();
    const add = (url: string, type: WebResourceType): void => {
      const hit = hits.get(url);
      if (!hit || seen.has(url)) return;
      seen.add(url);
      finds.push({ url, title: hit.title, pageAge: hit.pageAge, type });
    };
    for (const pick of result.answer?.picks ?? []) {
      const url = normaliseUrl(pick.url);
      if (url) add(url, pick.type);
    }
    if (!result.answer) for (const url of hits.keys()) add(url, fallbackType(url));
    // Videos found by search are kept (as `related`) only for the quota fallback; discovery confirms them.
    if (input.includeVideos) for (const url of hits.keys()) if (youtubeIdFromUrl(url)) add(url, 'related');
    return finds.slice(0, input.max + (input.includeVideos ? 6 : 0));
  }
}
