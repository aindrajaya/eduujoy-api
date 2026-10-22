import { type VideoDuration } from '../../domain';

export const VIDEO_SEARCH = Symbol('VideoSearch');

/** `videos.list` metadata (PRD-API §11): kept at most 30 days, then refreshed or deleted. */
export interface VideoDetails {
  youtubeId: string;
  title: string;
  channel: string;
  /** Rounded up to whole minutes. */
  durationMin: number;
  /** `YYYY-MM-DD`. */
  publishedAt: string | null;
  language: string | null;
  embeddable: boolean;
  public: boolean;
  madeForKids: boolean;
}

/** The provider refused a call because its daily quota is spent; the guard treats the day as used up. */
export class VideoQuotaExceededError extends Error {
  override name = 'VideoQuotaExceededError';
}

/** YouTube Data API v3 (`VideoSearch` in PRD-API §11). */
export interface VideoSearch {
  /** `search.list`: video ids for a query, best first. Costs one call of the 100-a-day `search.list` limit. */
  search(input: { query: string; maxResults: number; duration: VideoDuration; signal?: AbortSignal }): Promise<string[]>;
  /** `videos.list`: metadata for up to 50 ids; unknown or removed videos are left out. */
  details(ids: string[], signal?: AbortSignal): Promise<VideoDetails[]>;
}
