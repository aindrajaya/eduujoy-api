import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { type Paper, type PaperSearch } from '../application/ports/paper-search';
import { type FetchFn, getJson, ProviderHttpError } from './http-json';

const OPENALEX = 'https://api.openalex.org/works';
const ARXIV = 'https://export.arxiv.org/api/query';
const TIMEOUT_MS = 10_000;
const MAX_ABSTRACT_CHARS = 6_000;

const location = z
  .object({ landing_page_url: z.string().nullish(), source: z.object({ display_name: z.string().nullish() }).nullish() })
  .nullish();
const worksBody = z.object({
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        doi: z.string().nullish(),
        publication_date: z.string().nullish(),
        primary_location: location,
        best_oa_location: location,
        locations: z.array(location).nullish(),
        abstract_inverted_index: z.record(z.string(), z.array(z.number().int().nonnegative())).nullish(),
      }),
    )
    .default([]),
});

/** OpenAlex ships abstracts as word → positions; rebuild the text (capped). */
export function abstractFromIndex(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) if (p < 5_000) words[p] = word;
  const text = words.filter(Boolean).join(' ').trim();
  return text ? text.slice(0, MAX_ABSTRACT_CHARS) : null;
}

const ARXIV_ABS = /arxiv\.org\/abs\/([\w.\-/]+?)(?:v\d+)?$/i;

export function arxivIdFrom(url: string | null | undefined): string | null {
  return url ? (ARXIV_ABS.exec(url)?.[1] ?? null) : null;
}

const decode = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The few Atom fields the arXiv fallback needs; arXiv's feed is regular enough for this. */
export function parseArxivFeed(xml: string): Paper[] {
  const papers: Paper[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const field = (name: string): string | null => {
      const value = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry ?? '')?.[1];
      return value ? decode(value) : null;
    };
    const arxivId = arxivIdFrom(field('id'));
    const title = field('title');
    if (!arxivId || !title) continue;
    papers.push({
      title,
      url: `https://arxiv.org/abs/${arxivId}`,
      doi: null,
      arxivId,
      publishedAt: field('published')?.slice(0, 10) ?? null,
      source: 'arXiv',
      abstract: field('summary')?.slice(0, MAX_ABSTRACT_CHARS) ?? null,
    });
  }
  return papers;
}

/**
 * OpenAlex works search (free; the key raises the daily allowance) with an arXiv fallback when OpenAlex
 * fails (PRD-API §11). Papers link to an open-access landing page when there is one, else the DOI.
 */
export class OpenAlexAdapter implements PaperSearch {
  private readonly logger = new Logger(OpenAlexAdapter.name);

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async search(input: { query: string; limit: number; signal?: AbortSignal }): Promise<Paper[]> {
    try {
      return await this.openAlex(input);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, 'OpenAlex failed; trying arXiv');
      return this.arxiv(input);
    }
  }

  private async openAlex(input: { query: string; limit: number; signal?: AbortSignal }): Promise<Paper[]> {
    const url = new URL(OPENALEX);
    url.search = new URLSearchParams({
      search: input.query,
      filter: 'is_retracted:false',
      'per-page': String(Math.min(Math.max(input.limit, 1), 25)),
      select: 'title,doi,publication_date,primary_location,best_oa_location,locations,abstract_inverted_index',
      api_key: this.apiKey,
    }).toString();
    const { status, body } = await getJson(this.fetchFn, url, TIMEOUT_MS, input.signal);
    if (status < 200 || status >= 300) throw new ProviderHttpError('OpenAlex', status, null);
    return worksBody.parse(body).results.flatMap((work) => {
      const title = work.title?.trim();
      if (!title) return [];
      const doi = work.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') ?? null;
      const landings = [work.best_oa_location, work.primary_location, ...(work.locations ?? [])].map((l) => l?.landing_page_url ?? null);
      const arxivId = landings.map(arxivIdFrom).find((id) => id !== null) ?? null;
      const url = work.best_oa_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : null);
      if (!url) return [];
      return [
        {
          title,
          url,
          doi,
          arxivId,
          publishedAt: work.publication_date ?? null,
          source: work.primary_location?.source?.display_name ?? work.best_oa_location?.source?.display_name ?? 'OpenAlex',
          abstract: abstractFromIndex(work.abstract_inverted_index),
        },
      ];
    });
  }

  private async arxiv(input: { query: string; limit: number; signal?: AbortSignal }): Promise<Paper[]> {
    const url = new URL(ARXIV);
    url.search = new URLSearchParams({ search_query: `all:${input.query}`, start: '0', max_results: String(Math.min(input.limit, 25)) }).toString();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await this.fetchFn(url, { signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout });
    if (!response.ok) throw new ProviderHttpError('arXiv', response.status, null);
    return parseArxivFeed(await response.text());
  }
}
