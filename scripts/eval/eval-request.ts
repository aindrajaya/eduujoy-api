import { type ServedCard } from '../../src/modules/discovery/application/ports/card.reader';
import { aliasPool } from '../../src/modules/pathing/application/assemble';
import { type DesignRequest } from '../../src/modules/pathing/application/ports/path-designer';
import { type CardSelection, coreConcepts, selectCards } from '../../src/modules/pathing/application/select-cards';
import { PATH_LENGTH_WEEKS, type PoolCard, stepMaxMinutes, targetStage } from '../../src/modules/pathing/domain';
import { type EvalCase } from './path-eval-rules';

/**
 * The designer's request for one eval case, built exactly as generate-path builds it: the learner's
 * inputs and the pool's cards. It reads only the case's learner fields (topic, placement, goal, hours,
 * formats), never `reference`: the references judge the path and must not shape it.
 */
export function buildEvalRequest(
  c: Pick<EvalCase, 'placement' | 'goal' | 'weeklyHours' | 'formats'>,
  topic: { name: string; domain: string | null },
  cards: ServedCard[],
  language: string,
): { request: DesignRequest; validate: PoolCard[]; byAlias: Map<string, ServedCard>; selection: CardSelection } {
  const selection = selectCards(cards, { language, formats: c.formats, stepMax: stepMaxMinutes(c.weeklyHours) });
  const { design, validate, byAlias } = aliasPool(selection.cards);
  const target = targetStage(c.placement.stage);
  const request: DesignRequest = {
    topic: { name: topic.name, domain: topic.domain ?? 'unknown' },
    placement: { stage: c.placement.stage, bloom: c.placement.bloom as DesignRequest['placement']['bloom'] },
    target,
    goal: c.goal,
    weeklyHours: c.weeklyHours,
    budgetMinutes: Math.round(c.weeklyHours * 60 * PATH_LENGTH_WEEKS),
    stepMaxMinutes: stepMaxMinutes(c.weeklyHours),
    formats: c.formats,
    cards: design,
    coreConcepts: coreConcepts(selection.cards, { stages: target === c.placement.stage ? [target] : [c.placement.stage, target], target }),
    formatFallback: selection.formatFallback,
    budgetScope: 'operator',
  };
  return { request, validate, byAlias, selection };
}
