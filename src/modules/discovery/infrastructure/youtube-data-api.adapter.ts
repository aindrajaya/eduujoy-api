import { z } from 'zod';
import { type VideoDetails, VideoQuotaExceededError, type VideoSearch } from '../application/ports/video-search';
import { type VideoDuration } from '../domain';
import { type FetchFn, getJson, ProviderHttpError } from './http-json';

const BASE = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 10_000;

const errorBody = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).optional() }) }).partial();
const searchBody = z.object({ items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }) })).default([]) });
const videosBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          channelTitle: z.string(),
          publishedAt: z.string().optional(),
          defaultAudioLanguage: z.string().optional(),
          defaultLanguage: z.string().optional(),
        }),
        contentDetails: z.object({ duration: z.string() }),
        status: z.object({ privacyStatus: z.string(), embeddable: z.boolean().optional(), madeForKids: z.boolean().optional(), uploadStatus: z.string().optional() }),
      }),
    )
    .default([]),
});

/** Whole minutes, rounded up, from an ISO 8601 duration such as `PT1H2M3S`; null when unparseable. */
export function isoDurationMinutes(value: string): number | null {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match || value === 'P' || value === 'PT') return null;
  const n = (i: number): number => Number(match[i]) || 0;
  const seconds = n(1) * 86_400 + n(2) * 3600 + n(3) * 60 + n(4);
  return Math.ceil(seconds / 60);
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded']);

/**
 * YouTube Data API v3 with an API key (PRD-API §11). `search.list` costs one call of its own 100-a-day
 * limit; `videos.list` costs 1 unit of the 10,000-unit quota.
 */
export class YouTubeDataApiAdapter implements VideoSearch {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async search(input: { query: string; maxResults: number; duration: VideoDuration; signal?: AbortSignal }): Promise<string[]> {
    const url = new URL(`${BASE}/search`);
    url.search = new URLSearchParams({
      part: 'id',
      type: 'video',
      q: input.query,
      maxResults: String(Math.min(Math.max(input.maxResults, 1), 50)),
      relevanceLanguage: 'en',
      safeSearch: 'strict',
      videoEmbeddable: 'true',
      ...(input.duration === 'any' ? {} : { videoDuration: input.duration }),
    }).toString();
    const body = searchBody.parse(await this.get(url, input.signal));
    return body.items.map((item) => item.id.videoId).filter((id): id is string => typeof id === 'string');
  }

  async details(ids: string[], signal?: AbortSignal): Promise<VideoDetails[]> {
    if (ids.length === 0) return [];
    const url = new URL(`${BASE}/videos`);
    url.search = new URLSearchParams({ part: 'snippet,contentDetails,status', id: ids.slice(0, 50).join(','), maxResults: '50' }).toString();
    const body = videosBody.parse(await this.get(url, signal));
    return body.items.flatMap((item) => {
      const durationMin = isoDurationMinutes(item.contentDetails.duration);
      if (durationMin === null) return [];
      return [
        {
          youtubeId: item.id,
          title: item.snippet.title,
          channel: item.snippet.channelTitle,
          durationMin,
          publishedAt: item.snippet.publishedAt?.slice(0, 10) ?? null,
          language: item.snippet.defaultAudioLanguage ?? item.snippet.defaultLanguage ?? null,
          embeddable: item.status.embeddable ?? false,
          public: item.status.privacyStatus === 'public' && (item.status.uploadStatus ?? 'processed') === 'processed',
          madeForKids: item.status.madeForKids ?? false,
        },
      ];
    });
  }

  private async get(url: URL, signal?: AbortSignal): Promise<unknown> {
    const keyed = new URL(url);
    keyed.searchParams.set('key', this.apiKey);
    const { status, body } = await getJson(this.fetchFn, keyed, TIMEOUT_MS, signal);
    if (status >= 200 && status < 300) return body;
    const reason = errorBody.safeParse(body).data?.error?.errors?.[0]?.reason ?? null;
    if (status === 403 && reason && QUOTA_REASONS.has(reason)) throw new VideoQuotaExceededError(`YouTube quota: ${reason}`);
    throw new ProviderHttpError('YouTube Data API', status, reason);
  }
}
