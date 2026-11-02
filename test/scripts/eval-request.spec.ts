import { buildEvalRequest } from '../../scripts/eval/eval-request';
import { type EvalCase } from '../../scripts/eval/path-eval-rules';
import { renderRequest } from '../../src/modules/pathing/infrastructure/claude-path-designer';

const SENTINEL = 'SENTINEL-REFERENCE-7f3a';

const evalCase: EvalCase = {
  id: 'pe-001',
  topic: 'python',
  placement: { stage: 'novice', bloom: 'C1' },
  goal: 'Read scripts at work',
  weeklyHours: 2,
  formats: [],
  smoke: true,
  reference: {
    steps: { min: 6, max: 6 },
    startBloomMax: 'C2',
    endBloom: 'C2',
    mustCover: [`${SENTINEL} concept`],
    orderConstraints: [[`${SENTINEL} a`, `${SENTINEL} b`]],
    misconceptionsToAvoid: [`${SENTINEL} myth`],
    notes: `${SENTINEL} notes`,
    sop: [{ objective: `${SENTINEL} objective`, bloom: 'C1', concepts: [`${SENTINEL} sop concept`] }],
  },
};

const card = {
  resourceId: 'r1',
  type: 'article' as const,
  url: 'https://example.com/1',
  youtubeId: null,
  title: 'Python basics',
  source: 'example.com',
  durationMin: null,
  readingMin: 10,
  published: null,
  language: 'en',
  stage: 'novice' as const,
  bloomLevels: ['C1' as const],
  prerequisites: [],
  concepts: [{ name: 'Variables', start: null, end: null }],
  keyTakeaways: ['Names hold values.'],
  whyThis: null,
  quality: { relevance: 80, accuracySignals: 80, recency: 80, teaching: 80 },
  qualityScore: 80,
};

describe('the eval designer input (lead, 2 Nov 2026: references must never reach the designer)', () => {
  it('carries no reference field, and none of their text, in the request or the rendered prompt', () => {
    const { request } = buildEvalRequest(evalCase, { name: 'Python', domain: 'software' }, [card], 'en');

    expect(JSON.stringify(request)).not.toContain(SENTINEL);
    expect(renderRequest(request)).not.toContain(SENTINEL);
    expect(Object.keys(request)).not.toEqual(expect.arrayContaining(['reference']));
    // What it does carry comes from the learner fields and the pool.
    expect(request).toMatchObject({ goal: 'Read scripts at work', weeklyHours: 2, target: 'novice' });
    // One card teaches Variables: below two shared concepts, single-card ones fill the list.
    expect(request.coreConcepts).toEqual(['Variables']);
  });
});
