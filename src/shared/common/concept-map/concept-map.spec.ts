import { type ConceptMap, conceptMapCheck, pathConceptMap } from '.';

const stage = (name: ConceptMap['stages'][number]['stage'], prefix: string, prerequisites: [string, string][] = []): ConceptMap['stages'][number] => ({
  stage: name,
  bloomBand: ['C1'],
  concepts: [1, 2].map((n) => ({ id: `${prefix}-${n}`, name: `${prefix} ${n}`, aliases: [], bloom: 'C1' as const, summary: '' })),
  prerequisites,
  misconceptions: [{ text: `${prefix} myth`, concepts: [`${prefix}-1`] }],
});

const map: ConceptMap = {
  version: 1,
  topic: 't',
  language: 'en',
  stages: [stage('novice', 'nov', [['nov-1', 'nov-2']]), stage('advanced_beginner', 'adb', [['nov-1', 'adb-1'], ['adb-1', 'adb-2']]), stage('competent', 'com', [['nov-2', 'com-1'], ['adb-2', 'com-1']]), stage('proficient', 'pro'), stage('expert', 'exp')],
};

describe('pathConceptMap', () => {
  it("keeps the path's stages, and only edges with both ends in them (a lower-stage prerequisite is assumed known)", () => {
    const part = pathConceptMap(map, ['advanced_beginner', 'competent']);
    expect(part.stages.map((s) => s.stage)).toEqual(['advanced_beginner', 'competent']);
    expect(part.prerequisites).toEqual([
      ['adb-1', 'adb-2'],
      ['adb-2', 'com-1'],
    ]);
    expect(part.stages[0]?.misconceptions).toEqual(['adb myth']);
    expect(conceptMapCheck(part)).toEqual({ ids: ['adb-1', 'adb-2', 'com-1', 'com-2'], prerequisites: part.prerequisites });
    expect(conceptMapCheck(null)).toBeNull();
  });
});
