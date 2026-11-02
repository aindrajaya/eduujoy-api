import { type ServedCard } from '../../discovery/application/ports/card.reader';
import { type PoolCard } from '../domain';
import { type DesignCard, type DesignedStep } from './ports/path-designer';
import { type NewStep } from './ports/path.repository';

/** `mm:ss` or `h:mm:ss` to seconds; null for anything else. */
export function toSeconds(stamp: string | null | undefined): number | null {
  if (!stamp || !/^\d{1,3}(:\d{1,2}){1,2}$/.test(stamp)) return null;
  return stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

const clock = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/** The pool under short aliases (r1…rN), for the designer and for the validator. */
export function aliasPool(cards: ServedCard[]): { design: DesignCard[]; validate: PoolCard[]; byAlias: Map<string, ServedCard> } {
  const byAlias = new Map(cards.map((c, i) => [`r${i + 1}`, c]));
  const design: DesignCard[] = [];
  const validate: PoolCard[] = [];
  for (const [alias, c] of byAlias) {
    const concepts = c.concepts.map((k) => ({ name: k.name, start: k.start ?? null, end: k.end ?? null }));
    design.push({
      alias,
      type: c.type,
      title: c.title,
      source: c.source,
      stage: c.stage,
      bloomLevels: c.bloomLevels,
      durationMin: c.type === 'youtube' ? c.durationMin : null,
      readingMin: c.type === 'youtube' ? null : c.readingMin,
      prerequisites: c.prerequisites,
      concepts,
      keyTakeaways: c.keyTakeaways,
      relevance: c.quality.relevance,
    });
    validate.push({
      alias,
      type: c.type,
      durationSec: c.type === 'youtube' && c.durationMin !== null ? c.durationMin * 60 : null,
      readingMin: c.type === 'youtube' ? null : c.readingMin,
      prerequisites: c.prerequisites,
      concepts: concepts.map((k) => ({ name: k.name, startSec: toSeconds(k.start), endSec: toSeconds(k.end) })),
    });
  }
  return { design, validate, byAlias };
}

/**
 * A validated design as rows: aliases become resource ids, video ranges are written into the action
 * text (the contract's actions are text only), items get ids, and answer keys go to their own column.
 */
/** Added to step 1 when the learner's formats couldn't be honoured (v2): code says it, not the model. */
export const FORMAT_FALLBACK_NOTE = 'Note: this topic has few resources in your preferred format yet, so this path mixes in other formats.';

export function assembleSteps(steps: DesignedStep[], byAlias: Map<string, ServedCard>, options: { formatFallback?: boolean } = {}): NewStep[] {
  return steps.map((step, index) => ({
    n: step.n,
    objective: step.objective.trim(),
    bloom: step.bloom,
    actions: [
      ...(index === 0 && options.formatFallback ? [{ text: FORMAT_FALLBACK_NOTE, resource: null, startSec: null, endSec: null }] : []),
      ...step.actions,
    ].map((a, i) => ({
      n: i + 1,
      text: a.resource && a.startSec != null && a.endSec != null ? `${a.text.trim()} (${clock(a.startSec)}–${clock(a.endSec)})` : a.text.trim(),
      done: false,
    })),
    resourceIds: step.resources.map((alias) => (byAlias.get(alias) as ServedCard).resourceId),
    checkpoint: {
      items: step.checkpoint.items.map((item, i) => ({
        id: `i${i + 1}`,
        kind: item.kind,
        prompt: item.prompt,
        ...(item.kind === 'single_choice' || item.kind === 'multi_choice' ? { options: item.options } : {}),
      })),
      rubric: step.checkpoint.rubric,
      passScore: step.checkpoint.passScore,
    },
    answerKeys: step.checkpoint.items.map((item) => ({ correctOptionIds: item.correctOptionIds, expectedAnswer: item.expectedAnswer })),
    doneWhen: step.doneWhen.trim(),
    estMinutes: step.estMinutes,
  }));
}
