export const LINK_CHECKER = Symbol('LinkChecker');

export interface LinkCheck {
  ok: boolean;
  /** The final HTTP status, or null when the request never got one (DNS, timeout, refused address). */
  status: number | null;
}

/** HTTP liveness and page text for analysis (master PRD §12: every URL must return 2xx). */
export interface LinkChecker {
  check(url: string, signal?: AbortSignal): Promise<LinkCheck>;
  /** The page's readable text, cut at `maxChars`; null when it is not live or not HTML or plain text. */
  fetchText(url: string, maxChars: number, signal?: AbortSignal): Promise<string | null>;
}
