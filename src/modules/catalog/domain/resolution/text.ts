/** Characters stripped from both ends of a topic key. Whitespace is already single spaces by then. */
const EDGE_CHARS = new Set(' "\'`.,;:!?()[]{}-');

/** Lower-case, NFKC, single spaces, no surrounding punctuation: the key for exact name and alias matches. */
export function normaliseTopicText(text: string): string {
  const key = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  // Two index scans instead of a `[...]+$` regex: the regex backtracks quadratically on long runs of
  // punctuation inside the text (CodeQL js/polynomial-redos).
  let start = 0;
  let end = key.length;
  while (start < end && EDGE_CHARS.has(key.charAt(start))) start += 1;
  while (end > start && EDGE_CHARS.has(key.charAt(end - 1))) end -= 1;
  return key.slice(start, end);
}

/** The learner text that is embedded as a query: NFKC, single spaces, trimmed, case kept. */
export function queryText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Learner text as a display name when no normaliser is available: trimmed, single-spaced, first letter upper. */
export function fallbackTopicName(text: string): string {
  const name = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** kebab-case, at most 80 chars (the seed format's slug rule); `topic` when nothing survives. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\+\+/g, 'pp')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'topic';
}

export interface TopicDocumentSource {
  canonicalName: string;
  aliases: string[];
  description: string | null;
}

/** What gets embedded for a topic (PRD-API §8): canonical name + aliases + one-line description. */
export function topicDocument(topic: TopicDocumentSource): { title: string; text: string } {
  const parts = [topic.canonicalName];
  if (topic.aliases.length > 0) parts.push(`Also known as: ${topic.aliases.join(', ')}`);
  if (topic.description) parts.push(topic.description);
  return { title: topic.canonicalName, text: parts.join('. ') };
}
