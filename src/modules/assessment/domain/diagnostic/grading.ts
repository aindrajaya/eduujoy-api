/** Auto-gradable diagnostic kinds; `scenario` items are multiple choice. short_answer is never served. */
export type GradableKind = 'single_choice' | 'multi_choice' | 'scenario';

export interface BankItem {
  id: string;
  cell: number;
  kind: GradableKind;
  /** Correct option ids; never leaves the API. */
  answerKey: readonly string[];
  reviewed: boolean;
}

export interface Answer {
  itemId: string;
  optionIds?: readonly string[];
  skipped?: boolean;
}

/** Exact set match against the answer key; a skipped or empty answer is wrong. */
export function isCorrect(item: BankItem, answer: Answer): boolean {
  if (answer.skipped || !answer.optionIds || answer.optionIds.length === 0) return false;
  const chosen = new Set(answer.optionIds);
  return chosen.size === item.answerKey.length && item.answerKey.every((id) => chosen.has(id));
}
