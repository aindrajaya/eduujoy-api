import { citedMinutes, type DraftStep, MAX_RESOURCE_STEPS, type PoolCard, stepMaxMinutes, validatePath, type ValidationInput } from './path-validator';
import { type Bloom, targetStage } from './vocab';

const card = (alias: string, over: Partial<PoolCard> = {}): PoolCard => ({
  alias,
  type: 'article',
  durationSec: null,
  prerequisites: [],
  concepts: [],
  ...over,
});

const POOL: PoolCard[] = [
  card('r1', { type: 'youtube', durationSec: 600, concepts: [{ name: 'State basics', startSec: 0, endSec: 240 }] }),
  card('r2', { type: 'article', concepts: [{ name: 'Effects', startSec: null, endSec: null }] }),
  card('r3', { type: 'official_doc', concepts: [{ name: 'Custom hooks', startSec: null, endSec: null }], prerequisites: ['effects'] }),
  card('r4', { type: 'article' }),
  card('r5', { type: 'article' }),
  card('r6', { type: 'article' }),
];

const step = (n: number, bloom: Bloom, over: Partial<DraftStep> = {}): DraftStep => ({
  n,
  objective: `Objective ${n}`,
  bloom,
  resources: ['r4'],
  actions: [{ text: 'Read it' }],
  checkpoint: { items: [{ kind: 'open', prompt: 'Explain' }], rubric: ['clear'], passScore: 80 },
  doneWhen: 'You can explain it',
  estMinutes: 30,
  ...over,
});

/** An advanced-beginner C3 learner on a competent path (C3–C4), 4 h/week. */
const valid = (): ValidationInput => ({
  placementBloom: 'C3',
  target: 'competent',
  weeklyHours: 4,
  pool: POOL.map((c) => ({ ...c, prerequisites: [...c.prerequisites] })),
  steps: [
    step(1, 'C3', { resources: ['r1'], actions: [{ text: 'Watch 0:30–3:00', resource: 'r1', startSec: 30, endSec: 180 }] }),
    step(2, 'C3', { resources: ['r2'] }),
    step(3, 'C3', { resources: ['r3', 'r4'] }),
    step(4, 'C4'),
    step(5, 'C4', { resources: ['r5'] }),
    step(6, 'C4', { resources: ['r6'] }),
  ],
});

const errorsOf = (over: (i: ValidationInput) => void): string[] => {
  const input = valid();
  over(input);
  return validatePath(input).errors;
};

describe('validatePath (A9 plan §2)', () => {
  it('accepts a well-formed path', () => {
    expect(validatePath(valid())).toEqual({ ok: true, errors: [], flags: [] });
  });

  it('needs 6 to 12 steps numbered 1…n', () => {
    expect(errorsOf((i) => i.steps.splice(5))).toContain('The path has 5 steps; it needs 6 to 12.');
    expect(errorsOf((i) => ((i.steps[1] as DraftStep).n = 7))).toContain('Step 2 is numbered 7; number the steps 1 to 6 in order.');
  });

  it('rejects an invented resource, a duplicate, and 0 or 4 resources (FR-15)', () => {
    expect(errorsOf((i) => ((i.steps[1] as DraftStep).resources = ['r9']))).toContain(
      'Step 2 cites r9, which is not in the resource list; use only the listed resources.',
    );
    expect(errorsOf((i) => ((i.steps[1] as DraftStep).resources = ['r2', 'r2']))).toContain('Step 2 cites the same resource twice.');
    expect(errorsOf((i) => ((i.steps[1] as DraftStep).resources = []))).toContain('Step 2 cites 0 resources; it needs 1 to 3.');
    expect(errorsOf((i) => ((i.steps[1] as DraftStep).resources = ['r1', 'r2', 'r3', 'r4']))).toContain('Step 2 cites 4 resources; it needs 1 to 3.');
  });

  it('keeps Bloom climbing one level at a time to the top of the target band', () => {
    expect(errorsOf((i) => ((i.steps[4] as DraftStep).bloom = 'C3'))).toContain('Step 5 drops to C3; Bloom levels never go down.');
    expect(errorsOf((i) => ((i.steps[0] as DraftStep).bloom = 'C5'))).toEqual(
      expect.arrayContaining([
        "Step 1 jumps to C5; each step may rise at most one Bloom level above the learner's level.",
        'Step 1 is C5, above the top of the competent band (C4).',
      ]),
    );
    expect(errorsOf((i) => {
      i.steps.forEach((s) => (s.bloom = 'C3'));
    })).toContain('The last step is C3; it must reach the top of the competent band (C4).');
    // A C1 learner can't open on C3.
    expect(errorsOf((i) => (i.placementBloom = 'C1'))).toContain(
      "Step 1 jumps to C3; each step may rise at most one Bloom level above the learner's level.",
    );
  });

  it('fails a resource whose prerequisite the path only covers in a later step', () => {
    // r3 needs "effects", covered by r2 in step 2; moving r3 to step 1 breaks the order.
    const errors = errorsOf((i) => {
      (i.steps[0] as DraftStep).resources = ['r3'];
      (i.steps[0] as DraftStep).actions = [{ text: 'Read' }];
      (i.steps[2] as DraftStep).resources = ['r4'];
    });
    expect(errors).toContain('Step 1 uses r3, which needs "effects", but the path only covers that in step 2; reorder the steps.');
    // A prerequisite nothing in the path covers is allowed (the learner may already know it).
    expect(errorsOf((i) => ((i.pool[2] as PoolCard).prerequisites = ['closures']))).toEqual([]);
  });

  it('keeps video actions inside the video and on one of its chapters', () => {
    const action = (startSec: number, endSec: number) => (i: ValidationInput) => {
      (i.steps[0] as DraftStep).actions = [{ text: 'Watch', resource: 'r1', startSec, endSec }];
    };
    expect(errorsOf(action(200, 100))).toContain("Step 1's action on r1 needs a start before its end.");
    expect(errorsOf(action(500, 900))).toContain("Step 1's action on r1 ends at 900s, past the video's end (600s).");
    expect(errorsOf(action(400, 500))).toContain("Step 1's action on r1 (400–500s) matches none of the video's chapters; point it at one of them.");
    expect(errorsOf(action(250, 300))).toEqual([]); // inside the 30 s slack around 0–240
    expect(errorsOf((i) => ((i.steps[1] as DraftStep).actions = [{ text: 'Watch', resource: 'r1', startSec: 0, endSec: 60 }]))).toContain(
      'Step 2 has an action on r1, which the step does not cite.',
    );
  });

  it('fits the total time into weeklyHours × 2 weeks', () => {
    // 6 × 30 = 180 min; 1 h/week × 2 weeks = 120.
    expect(errorsOf((i) => (i.weeklyHours = 1))).toContain('The steps add up to 180 minutes; at 1 hours a week the path must fit 120 minutes (2 weeks).');
    expect(errorsOf((i) => (i.weeklyHours = 1.5))).toEqual([]);
  });

  it('requires an objective, actions, a done-when and a 1–3 item checkpoint passing at 80', () => {
    const errors = errorsOf((i) => {
      i.steps[0] = step(1, 'C3', { objective: ' ', doneWhen: '', actions: [], checkpoint: { items: [], rubric: [], passScore: 70 }, estMinutes: 0 });
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'Step 1 has no objective.',
        'Step 1 has no done-when.',
        'Step 1 has no actions.',
        "Step 1's checkpoint has 0 items; it needs 1 to 3.",
        "Step 1's checkpoint pass score is 70; it must be 80.",
        "Step 1's estimated minutes must be a whole number of at least 1.",
      ]),
    );
  });

  it('flags, without failing, a path with fewer than 3 resource types', () => {
    const input = valid();
    input.steps.forEach((s, i) => {
      s.resources = [['r2', 'r2', 'r4', 'r4', 'r5', 'r6'][i] ?? 'r4'];
      s.actions = [{ text: 'Read' }];
    });
    expect(validatePath(input)).toEqual({ ok: true, errors: [], flags: ['few_resource_types'] });
  });
});

describe('cited time (v2, after check (c))', () => {
  const pool: PoolCard[] = [
    card('v', { type: 'youtube', durationSec: 41 * 60, concepts: [{ name: 'Part', startSec: 0, endSec: 41 * 60 }] }),
    card('t', { type: 'article', readingMin: 12 }),
  ];
  const at = (resources: string[], estMinutes: number, actions: DraftStep['actions'] = [{ text: 'Do it' }]): DraftStep => step(1, 'C3', { resources, estMinutes, actions });
  const cards = new Map(pool.map((c) => [c.alias, c]));

  it('needs the full length of a cited resource that no action narrows', () => {
    expect(citedMinutes(at(['v'], 18), cards)).toBe(41);
    expect(citedMinutes(at(['v', 't'], 60), cards)).toBe(53);
    expect(citedMinutes(at(['x'], 5), cards)).toBe(0);
  });

  it('counts only the ranges actions point at, when they do', () => {
    expect(citedMinutes(at(['v'], 18, [{ text: 'Watch', resource: 'v', startSec: 60, endSec: 660 }, { text: 'Practise' }]), cards)).toBe(10);
  });

  it('rejects a step that estimates less than its resources take', () => {
    const input = { ...valid(), pool, steps: valid().steps.map((s, i) => (i === 0 ? { ...s, resources: ['v'], actions: [{ text: 'Watch it' }], estMinutes: 18 } : { ...s, resources: ['t'], estMinutes: 30 })) };
    expect(validatePath(input).errors).toContain('Step 1 estimates 18 minutes but its resources take 41; give it at least 41, or point its actions at the parts of the videos it needs.');
  });
});

describe('the per-step cap', () => {
  it('rejects a step over 90 minutes', () => {
    const input = valid();
    (input.steps[2] as DraftStep).estMinutes = 120;
    expect(validatePath(input).errors).toContain('Step 3 takes 120 minutes; keep every step to 90 minutes or less, splitting it if needed.');
    (input.steps[2] as DraftStep).estMinutes = 90;
    expect(validatePath(input).errors).toEqual([]);
  });

  it('caps a step at half a week, at most 90 minutes (lead, 3 Nov 2026)', () => {
    expect([1, 1.5, 2, 3, 10].map(stepMaxMinutes)).toEqual([30, 45, 60, 90, 90]);
    const input = { ...valid(), weeklyHours: 1.5 };
    (input.steps[2] as DraftStep).estMinutes = 46;
    (input.steps[3] as DraftStep).estMinutes = 10;
    expect(validatePath(input).errors).toEqual(['Step 3 takes 46 minutes; keep every step to 45 minutes or less, splitting it if needed.']);
  });
});

describe('resource reuse (lead, 3 Nov 2026)', () => {
  it(`lets a resource serve at most ${MAX_RESOURCE_STEPS} steps`, () => {
    // r2 already serves step 2: a second step is fine.
    expect(errorsOf((i) => ((i.steps[4] as DraftStep).resources = ['r2']))).toEqual([]);
    const everywhere = (i: ValidationInput) => {
      (i.steps[4] as DraftStep).resources = ['r4'];
      (i.steps[5] as DraftStep).resources = ['r4'];
    };
    expect(errorsOf(everywhere)).toEqual([
      'r4 is cited in 4 steps (3, 4, 5, 6); a resource may serve at most 2 steps, so use another listed resource.',
    ]);
  });
});

describe('validatePath at the top stage (pe-090: expert C5, no next stage)', () => {
  it('accepts an expert-band path from C5 to C6 and rejects one that never reaches C6', () => {
    const expert = (blooms: Bloom[]): ValidationInput => ({
      ...valid(),
      placementBloom: 'C5',
      target: targetStage('expert'),
      steps: blooms.map((b, i) => step(i + 1, b, i === 0 ? { resources: ['r1'], actions: [{ text: 'Watch' }] } : { resources: [['r2', 'r4', 'r5', 'r6', 'r2'][i - 1] ?? 'r4'] })),
    });
    expect(validatePath(expert(['C5', 'C5', 'C6', 'C6', 'C6', 'C6'])).errors).toEqual([]);
    expect(validatePath(expert(['C5', 'C5', 'C5', 'C5', 'C5', 'C5'])).errors).toContain('The last step is C5; it must reach the top of the expert band (C6).');
  });
});

describe('targetStage', () => {
  it('climbs to the next stage; novice stays novice first, expert stays expert', () => {
    expect(targetStage('novice')).toBe('novice');
    expect(targetStage('advanced_beginner')).toBe('competent');
    expect(targetStage('competent')).toBe('proficient');
    expect(targetStage('proficient')).toBe('expert');
    expect(targetStage('expert')).toBe('expert');
  });
});
