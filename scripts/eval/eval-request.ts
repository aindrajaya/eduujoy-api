import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ServedCard } from '../../src/modules/discovery/application/ports/card.reader';
import { aliasPool } from '../../src/modules/pathing/application/assemble';
import { type DesignRequest } from '../../src/modules/pathing/application/ports/path-designer';
import { type ConceptMap, conceptMapSchema, pathConceptMap } from '../../src/shared/common/concept-map';
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
  /** The topic's concept map (seed/concept-maps, never seed/_eval), or null to design without one. */
  map: ConceptMap | null = null,
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
    conceptMap: map ? pathConceptMap(map, target === c.placement.stage ? [target] : [c.placement.stage, target]) : null,
    budgetScope: 'operator',
  };
  return { request, validate, byAlias, selection };
}

/** The concept-map directory: the only seed data the designer side of the eval reads. */
export const CONCEPT_MAP_DIR = join(__dirname, '..', '..', 'seed', 'concept-maps');

/**
 * A topic's concept map (user, 3 Nov 2026: maps confirmed), or null when it has none. It reads only
 * CONCEPT_MAP_DIR/<slug>.json, never seed/_eval: the references stay with the judge.
 */
export function readConceptMap(slug: string, dir: string = CONCEPT_MAP_DIR): ConceptMap | null {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const file = join(dir, `${slug}.json`);
  return existsSync(file) ? conceptMapSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
}
