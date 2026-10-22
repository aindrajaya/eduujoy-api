/**
 * Topic resolution thresholds (cosine, gemini-embedding-2 query vs document). PRD-API §8 started at
 * 0.88 / 0.75; tuned on the A6 golden set with real vectors (user decision, 22 Oct 2026): in-catalog
 * phrases scored 0.66–0.82 against their topic, out-of-catalog phrases at most 0.65.
 */
export const MATCH_THRESHOLD = 0.7;
export const CHOICE_THRESHOLD = 0.66;
export const MAX_CHOICES = 3;
/**
 * An auto-match also needs the nearest topic to beat the runner-up by this much; closer pairs are offered
 * as choices (user decision, 22 Oct 2026, after the held-out check). Tuned on the golden set only: the
 * golden phrases meant to be ambiguous had gaps up to 0.038, and the closest clear match above that 0.042.
 */
export const MATCH_MARGIN = 0.04;
