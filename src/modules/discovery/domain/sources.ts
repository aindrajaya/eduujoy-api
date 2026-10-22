// Source rules (FR-07, master PRD §12): domain deny list, URL normalisation, paper sources.

/**
 * Content farms and pages that are not learning material; sent as the web search tool's
 * `blocked_domains` and re-checked on every result. Kept short: the analyser's quality score does the rest.
 */
export const BLOCKED_DOMAINS: readonly string[] = [
  'pinterest.com',
  'quora.com',
  'scribd.com',
  'coursehero.com',
  'chegg.com',
  'studocu.com',
  'brainly.com',
  'slideshare.net',
  'answers.com',
  'ehow.com',
];

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;

/** https only, no credentials, no fragment, no tracking parameters; null when unusable. */
export function normaliseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  const text = url.toString();
  return url.pathname !== '/' && text.endsWith('/') && !url.search ? text.slice(0, -1) : text;
}

export function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

export function isBlocked(url: string, blocked: readonly string[] = BLOCKED_DOMAINS): boolean {
  const host = hostOf(url);
  return blocked.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

const YOUTUBE_ID = /^[\w-]{11}$/;

/** The video id of a youtube.com/watch, youtu.be or youtube.com/shorts URL. */
export function youtubeIdFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' && url.pathname === '/watch') id = url.searchParams.get('v');
  else if (host === 'youtube.com' && url.pathname.startsWith('/shorts/')) id = url.pathname.slice('/shorts/'.length);
  return id && YOUTUBE_ID.test(id) ? id : null;
}

export function youtubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** FR-07: papers only from recognised indexes or DOIs. */
export function isRecognisedPaper(paper: { doi: string | null; arxivId: string | null }): boolean {
  return Boolean(paper.doi ?? paper.arxivId);
}
