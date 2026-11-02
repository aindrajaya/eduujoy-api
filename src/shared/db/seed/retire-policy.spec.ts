import { retireRefusal, retirementCap, SeedRetireRefusedError } from './retire-policy';

describe('seed retirement policy (user decision, 2 Nov 2026)', () => {
  const base = { toRetire: 13, activeSeedItems: 11_200, filesItems: 11_187, expectRetired: 13 as number | undefined };

  it('caps a run at 1% of active seed-topic items or 200, whichever is lower', () => {
    expect(retirementCap(11_200)).toBe(112);
    expect(retirementCap(50_000)).toBe(200);
    expect(retirementCap(99)).toBe(0);
  });

  it('allows the expected run and a run with nothing to retire', () => {
    expect(retireRefusal(base)).toBeNull();
    expect(retireRefusal({ ...base, toRetire: 0, expectRetired: undefined, filesItems: 11_200 })).toBeNull();
  });

  it('requires the exact count whenever something would retire', () => {
    expect(retireRefusal({ ...base, expectRetired: undefined })).toBe('expect_missing');
    expect(retireRefusal({ ...base, expectRetired: 12 })).toBe('count_mismatch');
    expect(retireRefusal({ ...base, toRetire: 0, expectRetired: 13 })).toBe('count_mismatch');
  });

  it('refuses over the cap and a short or partial directory, before the count', () => {
    expect(retireRefusal({ ...base, toRetire: 113, filesItems: 11_200, expectRetired: 113 })).toBe('over_cap');
    expect(retireRefusal({ ...base, filesItems: 11_087 })).toBe('files_short');
    expect(retireRefusal({ ...base, filesItems: 0, toRetire: 11_200, expectRetired: undefined })).toBe('files_short');
  });

  it('explains each refusal with the numbers and says nothing was written', () => {
    const e = new SeedRetireRefusedError('expect_missing', { toRetire: 13, activeSeedItems: 11_200, filesItems: 11_187, cap: 112, expectRetired: undefined, keys: [] });
    expect(e.message).toBe('Refused, nothing written: 13 items would retire; re-run with --expect-retired 13 to confirm');
  });
});
