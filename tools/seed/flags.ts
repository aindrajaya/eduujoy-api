// Offline checks that decide which diagnostic items go to the paid review (seed:items-review). Each flag
// is a cue a test-wise learner could exploit or a sign the item may be ambiguous; nothing here calls an API.

export interface SeedItemOption {
  id: string;
  label: string;
}

export interface SeedItem {
  key: string;
  stage: string;
  bloom: string;
  kind: string;
  prompt: string;
  options?: SeedItemOption[];
  answerKey?: { optionIds?: string[] };
  rubric?: string[];
}

export type FlagCode =
  | 'longest-key'
  | 'key-in-prompt'
  | 'prompt-overlap-cue'
  | 'absolute-word-cue'
  | 'near-duplicate-options'
  | 'near-duplicate-prompt'
  | 'guessable-multi';

export const FLAG_HELP: Record<FlagCode, string> = {
  'longest-key': 'single-answer item whose key is the one longest option',
  'key-in-prompt': 'the key text appears word for word in the prompt',
  'prompt-overlap-cue': 'the key repeats at least 2 more prompt words than any distractor',
  'absolute-word-cue': 'every distractor uses an absolute word (always, never, only...) and the key none',
  'near-duplicate-options': 'the key and a distractor are near-identical prose (40+ characters, 90% alike)',
  'near-duplicate-prompt': 'the prompt shares at least 70% of its words with another long prompt in the topic',
  'guessable-multi': 'multi choice where all but one option is correct',
};

export interface Flagged {
  topic: string;
  item: SeedItem;
  flags: FlagCode[];
  /** Key length divided by the mean distractor length (single-answer items). */
  lengthRatio?: number;
  /** How much longer the key is than the longest distractor, as a fraction (longest-key items). */
  margin?: number;
}

const STAGE_ORDER = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'];
const ABSOLUTE = /\b(always|never|only|all|every|none|cannot|must|any)\b/i;
const STOP = new Set(['about', 'after', 'their', 'there', 'these', 'those', 'which', 'while', 'where', 'would', 'should', 'could', 'other', 'every', 'being', 'since', 'because']);

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length >= 5 && !STOP.has(w)));
}

/** 1 - normalised edit distance, on the raw text so signs and symbols count. */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return 1 - (prev[y.length] ?? 0) / Math.max(x.length, y.length, 1);
}

function jaccard(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Flags for one topic's items, most urgent first: longest-key novice items lead (user decision, 22 Oct 2026). */
export function flagTopic(topic: string, items: SeedItem[]): Flagged[] {
  const out: Flagged[] = [];
  items.forEach((item, index) => {
    const flags: FlagCode[] = [];
    const options = item.options ?? [];
    const keyIds = new Set(item.answerKey?.optionIds ?? []);
    const keys = options.filter((o) => keyIds.has(o.id));
    const distractors = options.filter((o) => !keyIds.has(o.id));
    let lengthRatio: number | undefined;
    let margin: number | undefined;

    const [key] = keys;
    if (keys.length === 1 && key && distractors.length > 0) {
      const lengths = options.map((o) => o.label.length);
      const max = Math.max(...lengths);
      if (key.label.length === max && lengths.filter((l) => l === max).length === 1) {
        flags.push('longest-key');
        margin = key.label.length / Math.max(...distractors.map((d) => d.label.length)) - 1;
      }
      lengthRatio = key.label.length / (distractors.reduce((n, o) => n + o.label.length, 0) / distractors.length);

      if (key.label.length >= 15 && item.prompt.toLowerCase().includes(key.label.toLowerCase())) flags.push('key-in-prompt');
      const promptWords = contentWords(item.prompt);
      const overlap = (label: string): number => [...contentWords(label)].filter((w) => promptWords.has(w)).length;
      if (overlap(key.label) >= Math.max(...distractors.map((d) => overlap(d.label))) + 2) flags.push('prompt-overlap-cue');
      if (!ABSOLUTE.test(key.label) && distractors.every((d) => ABSOLUTE.test(d.label))) flags.push('absolute-word-cue');
    }
    const prose = (label: string): boolean => label.length >= 40;
    if (keys.some((k) => prose(k.label) && distractors.some((d) => prose(d.label) && similarity(k.label, d.label) >= 0.9))) flags.push('near-duplicate-options');
    const longPrompt = (text: string): boolean => text.length >= 80;
    if (longPrompt(item.prompt) && items.some((other, j) => j !== index && longPrompt(other.prompt) && jaccard(item.prompt, other.prompt) >= 0.7)) {
      flags.push('near-duplicate-prompt');
    }
    if (item.kind === 'multi_choice' && options.length > 0 && keyIds.size >= options.length - 1) flags.push('guessable-multi');

    if (flags.length > 0) out.push({ topic, item, flags, lengthRatio, margin });
  });
  return out;
}

/** Review order: longest-key items first, by stage (novice first) then by how much the key stands out. */
export function byPriority(a: Flagged, b: Flagged): number {
  const longest = (f: Flagged): number => (f.flags.includes('longest-key') ? 0 : 1);
  return (
    longest(a) - longest(b) ||
    STAGE_ORDER.indexOf(a.item.stage) - STAGE_ORDER.indexOf(b.item.stage) ||
    (b.lengthRatio ?? 0) - (a.lengthRatio ?? 0) ||
    a.topic.localeCompare(b.topic) ||
    a.item.key.localeCompare(b.item.key)
  );
}
