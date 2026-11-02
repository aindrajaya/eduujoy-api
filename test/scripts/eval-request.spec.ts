import * as fs from 'node:fs';
import { buildEvalRequest, CONCEPT_MAP_DIR, readConceptMap } from '../../scripts/eval/eval-request';
import { type EvalCase } from '../../scripts/eval/path-eval-rules';
import { renderRequest } from '../../src/modules/pathing/infrastructure/claude-path-designer';

// Every file read in this spec is recorded (calls go through to the real fs).
jest.mock('node:fs', () => {
  const actual: typeof fs = jest.requireActual('node:fs');
  return { ...actual, readFileSync: jest.fn((...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args)) };
});

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

  it('with the concept map (user, 3 Nov 2026), reads only seed/concept-maps and still carries no reference text', () => {
    const read = fs.readFileSync as unknown as jest.Mock;
    read.mockClear();
    const map = readConceptMap('python');
    const files = read.mock.calls.map(([file]) => String(file));
    expect(files).toEqual([`${CONCEPT_MAP_DIR}/python.json`]);
    expect(files.some((f) => f.includes('_eval'))).toBe(false);

    const { request } = buildEvalRequest(evalCase, { name: 'Python', domain: 'software' }, [card], 'en', map);
    const rendered = renderRequest(request);
    expect(JSON.stringify(request)).not.toContain(SENTINEL);
    expect(rendered).not.toContain(SENTINEL);
    // The map is there: the novice stage only (a novice target), with its ids.
    expect(request.conceptMap?.stages.map((s) => s.stage)).toEqual(['novice']);
    expect(rendered).toContain('nov-1 ');
    expect(rendered).not.toContain('adb-1 ');
  });

  it('the maps record inputs from the public catalogue only, and none reads an eval file', () => {
    const provenance = JSON.parse(fs.readFileSync(`${CONCEPT_MAP_DIR}/_provenance.json`, 'utf8')) as { inputs: { files: string[]; fieldsSentPerTopic: string[] } };
    expect(provenance.inputs.files.filter((f) => f.includes('_eval'))).toEqual([]);
    expect(provenance.inputs.fieldsSentPerTopic.join(' ')).not.toMatch(/mustCover|misconception|orderConstraint|reference/i);
    expect(readConceptMap('../_eval/path-eval-v1')).toBeNull();
  });
});
