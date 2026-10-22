/** YouTube `search.list` has its own limit of 100 calls a day at 1 unit each (PRD-API §11). */
export const YOUTUBE_SEARCH_DAILY_LIMIT = 100;
/** The guard stops at 90, keeping 10 calls for operations (user decision, 22 Oct 2026). */
export const YOUTUBE_SEARCH_GUARD = 90;
export const YOUTUBE_SEARCH_QUOTA = 'youtube.search';

/** The YouTube quota day: quotas reset at midnight Pacific time. `YYYY-MM-DD`. */
export function pacificDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
