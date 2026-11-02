import { countsByTopic, refusal, retirementCap } from './retire-seed';

describe('retirement safety (lead gate, 2 Nov 2026)', () => {
  it('caps removals at 1% of the seed-topic items or 200, whichever is lower', () => {
    expect(retirementCap(11_200)).toBe(112);
    expect(retirementCap(50_000)).toBe(200);
    expect(retirementCap(99)).toBe(0);
  });

  const base = { candidates: 13, seedTopicItems: 11_200, filesItems: 11_187, apply: true, expectRemoved: 13 };

  it('lets the expected run through, and a dry run needs no expected count', () => {
    expect(refusal(base)).toBeNull();
    expect(refusal({ ...base, apply: false, expectRemoved: undefined })).toBeNull();
  });

  it('refuses an apply without --expect-removed, or with a different count', () => {
    expect(refusal({ ...base, expectRemoved: undefined })).toBe('refused_expect_missing');
    expect(refusal({ ...base, expectRemoved: 12 })).toBe('refused_count_mismatch');
    expect(refusal({ ...base, expectRemoved: 14 })).toBe('refused_count_mismatch');
  });

  it('refuses more candidates than the cap, even in a dry run and with a matching count', () => {
    const over = { ...base, candidates: 113, filesItems: 11_200, expectRemoved: 113 };
    expect(refusal(over)).toBe('refused_over_cap');
    expect(refusal({ ...over, apply: false, expectRemoved: undefined })).toBe('refused_over_cap');
  });

  it('refuses a near-empty or partial seed directory before anything else', () => {
    expect(refusal({ ...base, filesItems: 0, candidates: 11_200, expectRemoved: 11_200 })).toBe('refused_files_short');
    expect(refusal({ ...base, filesItems: 11_087 })).toBe('refused_files_short');
    expect(refusal({ ...base, filesItems: 11_088 })).toBeNull();
  });

  it('counts candidates per topic', () => {
    const c = (topic: string) => ({ id: topic, seedKey: `${topic}:k`, topic, answers: 0, heldBy: {} });
    expect(countsByTopic([c('calculus'), c('algebra'), c('calculus')])).toEqual({ calculus: 2, algebra: 1 });
  });
});
