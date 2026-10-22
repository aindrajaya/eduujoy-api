// Per-resource analysis cap (user requirement, 23 Oct 2026, after the A8 smoke: one proficient pool spent
// 1.3M input tokens, mostly two talks of 62 and 69 minutes at ~90 tokens per second of video).

/** Hard cap on one resource's analysis input, in tokens. */
export const ANALYSIS_TOKEN_CAP = 150_000;
/** Videos longer than this are not analysed (and discovery no longer collects them). */
export const VIDEO_MAX_MIN = 60;
/**
 * Gemini video at low media resolution: ~66 tokens per frame plus ~32 per second of audio. The smoke
 * measured ~90 per second at 1 frame per second; 98 errs high.
 */
const FRAME_TOKENS = 66;
const AUDIO_TOKENS_PER_SEC = 32;
/** Prompt, metadata and schema around the video. */
const OVERHEAD_TOKENS = 6_000;
/** Frame rates tried, highest first; fewer frames for longer videos. */
const FRAME_RATES = [1, 0.5, 0.25] as const;

export type VideoPlan =
  | { action: 'skip'; reason: string }
  | { action: 'analyse'; fps: number; endSec: number | null; estimatedTokens: number; clipped: boolean };

export function videoTokens(seconds: number, fps: number): number {
  return Math.ceil(seconds * (FRAME_TOKENS * fps + AUDIO_TOKENS_PER_SEC)) + OVERHEAD_TOKENS;
}

/**
 * How to analyse a video within the cap: the highest frame rate that fits; if none does, the lowest rate
 * clipped at the end offset that fits. Unknown or over-60-minute videos are skipped.
 */
export function videoPlan(durationMin: number | null, cap = ANALYSIS_TOKEN_CAP): VideoPlan {
  if (durationMin === null || durationMin <= 0) return { action: 'skip', reason: 'unknown video length' };
  if (durationMin > VIDEO_MAX_MIN) return { action: 'skip', reason: `video is ${durationMin} min, over ${VIDEO_MAX_MIN}` };
  const seconds = durationMin * 60;
  for (const fps of FRAME_RATES) {
    const estimatedTokens = videoTokens(seconds, fps);
    if (estimatedTokens <= cap) return { action: 'analyse', fps, endSec: null, estimatedTokens, clipped: false };
  }
  const fps = FRAME_RATES[FRAME_RATES.length - 1] as number;
  const endSec = Math.floor((cap - OVERHEAD_TOKENS) / (FRAME_TOKENS * fps + AUDIO_TOKENS_PER_SEC));
  return { action: 'analyse', fps, endSec, estimatedTokens: videoTokens(endSec, fps), clipped: true };
}

/** Text is cut to this many characters before analysis (~4 per token), well inside the cap. */
export const MAX_TEXT_CHARS = 32_000;

export function textTokens(chars: number): number {
  return Math.ceil(chars / 4) + OVERHEAD_TOKENS;
}
