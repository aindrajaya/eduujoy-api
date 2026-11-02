import { BANDS, type Bloom, bloomRank, PATH_LENGTH_WEEKS, type ResourceType, type Stage } from './vocab';

/** A served card as the designer saw it, under its short alias (r1…rN). */
export interface PoolCard {
  alias: string;
  type: ResourceType;
  durationSec: number | null;
  /** Reading time for text resources; null for videos or when unknown. */
  readingMin?: number | null;
  prerequisites: string[];
  concepts: { name: string; startSec: number | null; endSec: number | null }[];
}

/** An action as the designer writes it; `resource`, `startSec` and `endSec` point into a video. */
export interface DraftAction {
  text: string;
  resource?: string | null;
  startSec?: number | null;
  endSec?: number | null;
}

export interface DraftStep {
  n: number;
  objective: string;
  bloom: Bloom;
  resources: string[];
  actions: DraftAction[];
  checkpoint: { items: unknown[]; rubric: string[]; passScore: number };
  doneWhen: string;
  estMinutes: number;
}

export interface ValidationInput {
  steps: DraftStep[];
  pool: PoolCard[];
  placementBloom: Bloom;
  target: Stage;
  weeklyHours: number;
}

export type ValidationFlag = 'few_resource_types';

export interface ValidationResult {
  ok: boolean;
  /** Plain sentences, also fed back to the designer for its one regeneration. */
  errors: string[];
  /** Saved anyway, but sent for review (master: "minimum 3 resource types per path or flag"). */
  flags: ValidationFlag[];
}

export const MIN_STEPS = 6;
export const MAX_STEPS = 12;
export const PASS_SCORE = 80;
/** No step may ask for more than this (check (c): a 200-minute textbook step marked time realism down). */
export const MAX_STEP_MINUTES = 90;
/** A resource may serve at most this many steps (lead, 3 Nov 2026: reuse marked resource fit down). */
export const MAX_RESOURCE_STEPS = 2;

/**
 * The longest step a learner can take (lead, 3 Nov 2026): at most MAX_STEP_MINUTES, and at most half of
 * one week's hours, so a step fits about two sittings.
 */
export function stepMaxMinutes(weeklyHours: number): number {
  return Math.max(1, Math.min(MAX_STEP_MINUTES, Math.floor((weeklyHours * 60) / 2)));
}
const TIMESTAMP_SLACK_SEC = 30;

/** Lowercase, punctuation to spaces, single spaces: how concept and prerequisite names compare. */
export function normaliseConcept(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Code-side checks on a designed path before anything is saved (plan §2; FR-15: no invented
 * resources). Pure: the caller maps aliases back to resource ids only after this passes.
 */
export function validatePath(input: ValidationInput): ValidationResult {
  const errors: string[] = [];
  const { steps } = input;
  const cards = new Map(input.pool.map((c) => [c.alias, c]));
  const stepMax = stepMaxMinutes(input.weeklyHours);

  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) errors.push(`The path has ${steps.length} steps; it needs ${MIN_STEPS} to ${MAX_STEPS}.`);
  steps.forEach((step, i) => {
    if (step.n !== i + 1) errors.push(`Step ${i + 1} is numbered ${step.n}; number the steps 1 to ${steps.length} in order.`);
  });

  for (const step of steps) {
    const at = `Step ${step.n}`;
    if (!step.objective.trim()) errors.push(`${at} has no objective.`);
    if (!step.doneWhen.trim()) errors.push(`${at} has no done-when.`);
    if (step.actions.length === 0) errors.push(`${at} has no actions.`);
    if (step.checkpoint.items.length < 1 || step.checkpoint.items.length > 3) errors.push(`${at}'s checkpoint has ${step.checkpoint.items.length} items; it needs 1 to 3.`);
    if (step.checkpoint.passScore !== PASS_SCORE) errors.push(`${at}'s checkpoint pass score is ${step.checkpoint.passScore}; it must be ${PASS_SCORE}.`);
    if (!Number.isInteger(step.estMinutes) || step.estMinutes < 1) errors.push(`${at}'s estimated minutes must be a whole number of at least 1.`);
    if (step.estMinutes > stepMax) errors.push(`${at} takes ${step.estMinutes} minutes; keep every step to ${stepMax} minutes or less, splitting it if needed.`);

    if (step.resources.length < 1 || step.resources.length > 3) errors.push(`${at} cites ${step.resources.length} resources; it needs 1 to 3.`);
    if (new Set(step.resources).size !== step.resources.length) errors.push(`${at} cites the same resource twice.`);
    for (const alias of step.resources) if (!cards.has(alias)) errors.push(`${at} cites ${alias}, which is not in the resource list; use only the listed resources.`);

    for (const action of step.actions) {
      if (!action.resource) continue;
      const card = cards.get(action.resource);
      if (!step.resources.includes(action.resource) || !card) {
        errors.push(`${at} has an action on ${action.resource}, which the step does not cite.`);
        continue;
      }
      errors.push(...timestampErrors(at, action, card));
    }
  }

  errors.push(...reuseErrors(steps));
  errors.push(...citedTimeErrors(steps, cards));
  errors.push(...bloomErrors(input));
  errors.push(...prerequisiteErrors(steps, cards));

  const budget = Math.round(input.weeklyHours * 60 * PATH_LENGTH_WEEKS);
  const total = steps.reduce((n, s) => n + (Number.isFinite(s.estMinutes) ? s.estMinutes : 0), 0);
  if (total > budget) errors.push(`The steps add up to ${total} minutes; at ${input.weeklyHours} hours a week the path must fit ${budget} minutes (${PATH_LENGTH_WEEKS} weeks).`);

  const types = new Set(steps.flatMap((s) => s.resources).flatMap((a) => (cards.get(a) ? [cards.get(a)?.type] : [])));
  const flags: ValidationFlag[] = types.size < 3 ? ['few_resource_types'] : [];
  return { ok: errors.length === 0, errors, flags };
}

/** No resource serves more than MAX_RESOURCE_STEPS steps. */
function reuseErrors(steps: DraftStep[]): string[] {
  const used = new Map<string, number[]>();
  for (const step of steps) for (const alias of new Set(step.resources)) used.set(alias, [...(used.get(alias) ?? []), step.n]);
  return [...used.entries()]
    .filter(([, at]) => at.length > MAX_RESOURCE_STEPS)
    .map(([alias, at]) => `${alias} is cited in ${at.length} steps (${at.join(', ')}); a resource may serve at most ${MAX_RESOURCE_STEPS} steps, so use another listed resource.`);
}

/** Master rules 1–2: never down, at most one level up at a time (ZPD), ending on the band's top. */
function bloomErrors({ steps, placementBloom, target }: ValidationInput): string[] {
  const errors: string[] = [];
  const band = BANDS[target];
  let previous = bloomRank(placementBloom);
  steps.forEach((step, i) => {
    const rank = bloomRank(step.bloom);
    if (i > 0 && rank < bloomRank(steps[i - 1]?.bloom ?? step.bloom)) errors.push(`Step ${step.n} drops to ${step.bloom}; Bloom levels never go down.`);
    if (rank > previous + 1) errors.push(`Step ${step.n} jumps to ${step.bloom}; each step may rise at most one Bloom level above ${i === 0 ? "the learner's level" : 'the step before'}.`);
    if (rank > bloomRank(band.top)) errors.push(`Step ${step.n} is ${step.bloom}, above the top of the ${target} band (${band.top}).`);
    previous = Math.max(previous, rank);
  });
  const last = steps.at(-1);
  if (last && last.bloom !== band.top) errors.push(`The last step is ${last.bloom}; it must reach the top of the ${target} band (${band.top}).`);
  return errors;
}

/** Master line 340: a resource's prerequisite may not be a concept the path only covers later. */
function prerequisiteErrors(steps: DraftStep[], cards: Map<string, PoolCard>): string[] {
  const firstCovered = new Map<string, number>();
  for (const step of steps) {
    for (const alias of step.resources) {
      for (const concept of cards.get(alias)?.concepts ?? []) {
        const key = normaliseConcept(concept.name);
        if (key && !firstCovered.has(key)) firstCovered.set(key, step.n);
      }
    }
  }
  const errors: string[] = [];
  for (const step of steps) {
    for (const alias of step.resources) {
      for (const prerequisite of cards.get(alias)?.prerequisites ?? []) {
        const coveredAt = firstCovered.get(normaliseConcept(prerequisite));
        if (coveredAt !== undefined && coveredAt > step.n) {
          errors.push(`Step ${step.n} uses ${alias}, which needs "${prerequisite}", but the path only covers that in step ${coveredAt}; reorder the steps.`);
        }
      }
    }
  }
  return errors;
}

/** A video action's range lies inside the video and overlaps one of its timed concepts, if it has any. */
function timestampErrors(at: string, action: DraftAction, card: PoolCard): string[] {
  const { startSec, endSec } = action;
  if (startSec == null && endSec == null) return [];
  const where = `${at}'s action on ${card.alias}`;
  if (startSec == null || endSec == null || startSec < 0 || endSec <= startSec) return [`${where} needs a start before its end.`];
  if (card.durationSec !== null && endSec > card.durationSec + TIMESTAMP_SLACK_SEC) return [`${where} ends at ${endSec}s, past the video's end (${card.durationSec}s).`];
  const timed = card.concepts.filter((c) => c.startSec !== null && c.endSec !== null);
  const overlaps = timed.some((c) => startSec < (c.endSec as number) + TIMESTAMP_SLACK_SEC && endSec > (c.startSec as number) - TIMESTAMP_SLACK_SEC);
  return timed.length > 0 && !overlaps ? [`${where} (${startSec}–${endSec}s) matches none of the video's chapters; point it at one of them.`] : [];
}

/**
 * The minutes a step must at least allow for what it cites (v2, after check (c)): the video ranges its
 * actions point at, or a cited resource's full length (video duration or reading time) when no action
 * narrows it. Unknown lengths count 0.
 */
export function citedMinutes(step: DraftStep, cards: Map<string, PoolCard>): number {
  let seconds = 0;
  for (const alias of step.resources) {
    const card = cards.get(alias);
    if (!card) continue;
    const ranges = step.actions.filter((a) => a.resource === alias && a.startSec != null && a.endSec != null && a.endSec > a.startSec);
    if (ranges.length > 0) seconds += ranges.reduce((n, a) => n + ((a.endSec as number) - (a.startSec as number)), 0);
    else if (card.durationSec !== null) seconds += card.durationSec;
    else if (card.readingMin != null) seconds += card.readingMin * 60;
  }
  return Math.ceil(seconds / 60);
}

function citedTimeErrors(steps: DraftStep[], cards: Map<string, PoolCard>): string[] {
  return steps.flatMap((step) => {
    const needed = citedMinutes(step, cards);
    return Number.isInteger(step.estMinutes) && step.estMinutes < needed
      ? [`Step ${step.n} estimates ${step.estMinutes} minutes but its resources take ${needed}; give it at least ${needed}, or point its actions at the parts of the videos it needs.`]
      : [];
  });
}

