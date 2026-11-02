import { caseStages, dimensionsFor, judgeSchema, judgeSchemaFor, LEGACY_DIMENSIONS, legacyJudgeSchema, poolsNeeded, selectCases, estimate, summarise, type EvalCase, evalFile } from '../../scripts/eval/path-eval-rules';

const base = (id: string, topic: string, stage: EvalCase['placement']['stage'], bloom: string, smoke = true): EvalCase => ({
  id,
  topic,
  placement: { stage, bloom },
  goal: 'Learn it well',
  weeklyHours: 3,
  formats: [],
  smoke,
  reference: { mustCover: ['a'] },
});

describe('path eval rules', () => {
  it('parses the agreed case format and rejects a malformed case', () => {
    expect(evalFile.safeParse({ version: 1, cases: [base('pe-001', 'python', 'novice', 'C1')] }).success).toBe(true);
    expect(evalFile.safeParse({ version: 1, cases: [{ ...base('pe-001', 'python', 'novice', 'C1'), weeklyHours: 0 }] }).success).toBe(false);
    expect(evalFile.safeParse({ version: 1, cases: [base('x-1', 'python', 'novice', 'C1')] }).success).toBe(false);
  });

  it('selects the smoke subset or named cases', () => {
    const cases = [base('pe-001', 'a', 'novice', 'C1'), base('pe-002', 'b', 'novice', 'C1', false)];
    expect(selectCases(cases, { smoke: true, ids: [] }).map((c) => c.id)).toEqual(['pe-001']);
    expect(selectCases(cases, { smoke: false, ids: [] })).toHaveLength(2);
    expect(selectCases(cases, { smoke: true, ids: ['pe-002'] }).map((c) => c.id)).toEqual(['pe-002']);
  });

  it('needs the placement and target pools once each, one pool for novices and experts', () => {
    expect(caseStages(base('pe-001', 'sql', 'proficient', 'C4'))).toEqual(['proficient', 'expert']);
    expect(caseStages(base('pe-002', 'sql', 'novice', 'C1'))).toEqual(['novice']);
    expect(caseStages(base('pe-003', 'sql', 'expert', 'C5'))).toEqual(['expert']);
    const cases = [base('pe-001', 'sql', 'competent', 'C3'), base('pe-002', 'sql', 'advanced_beginner', 'C2'), base('pe-003', 'git', 'novice', 'C1')];
    expect(poolsNeeded(cases)).toEqual([
      { topic: 'sql', stage: 'competent' },
      { topic: 'sql', stage: 'proficient' },
      { topic: 'sql', stage: 'advanced_beginner' },
      { topic: 'git', stage: 'novice' },
    ]);
  });

  it('estimates pools and paths separately (lead, 23 Oct 2026)', () => {
    // 30 smoke cases, 8 cold pools: about $2.40 + $4.92.
    expect(estimate(30, 8)).toEqual({ poolsUsd: 2.4, pathsUsd: 4.92, totalUsd: 7.32 });
    expect(estimate(0, 0)).toEqual({ poolsUsd: 0, pathsUsd: 0, totalUsd: 0 });
  });

  it('passes the gate only at a mean of 4.0 on every dimension with no bad links, counting review as 1', () => {
    const good = { prerequisiteOrder: 5, bloomProgression: 4, resourceFit: 4, timeRealism: 4, coverage: 4 };
    expect(summarise([{ id: 'a', scores: good, badLinks: 0 }])).toMatchObject({ pass: true, underReview: 0 });
    expect(summarise([{ id: 'a', scores: good, badLinks: 1 }]).pass).toBe(false);
    const withReview = summarise([
      { id: 'a', scores: { ...good, resourceFit: 5 }, badLinks: 0 },
      { id: 'b', scores: null, badLinks: 0 },
    ]);
    expect(withReview).toMatchObject({ means: { prerequisiteOrder: 3, resourceFit: 3 }, underReview: 1, pass: false });
    expect(summarise([]).pass).toBe(false);
  });

  it('scores coverage from judge v3, and only the four legacy dimensions for v1 and v2 (lead, 3 Nov 2026)', () => {
    expect(dimensionsFor('v2')).toEqual(LEGACY_DIMENSIONS);
    expect(dimensionsFor('v1')).toEqual(LEGACY_DIMENSIONS);
    expect(dimensionsFor('v3')).toEqual([...LEGACY_DIMENSIONS, 'coverage']);
    expect(judgeSchemaFor('v2')).toBe(legacyJudgeSchema);
    expect(judgeSchemaFor('v3')).toBe(judgeSchema);
    // A v2 re-judge has no coverage score: it is left out, not counted as 1.
    const legacy = { prerequisiteOrder: 4, bloomProgression: 4, resourceFit: 4, timeRealism: 4 };
    expect(summarise([{ id: 'a', scores: legacy, badLinks: 0 }], LEGACY_DIMENSIONS)).toEqual({ means: legacy, badLinks: 0, underReview: 0, pass: true });
    // Under v3 a missing coverage score fails the gate.
    expect(summarise([{ id: 'a', scores: legacy, badLinks: 0 }]).pass).toBe(false);
  });
});
