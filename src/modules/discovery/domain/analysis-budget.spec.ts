import { ANALYSIS_TOKEN_CAP, MAX_TEXT_CHARS, textTokens, VIDEO_MAX_MIN, videoPlan, videoTokens } from './analysis-budget';
import { poolPlan } from './pool-plan';
import { STAGES } from './types';

describe('per-resource analysis cap', () => {
  it('never plans a video analysis over the cap, for any length up to 60 minutes', () => {
    for (let min = 1; min <= VIDEO_MAX_MIN; min++) {
      const plan = videoPlan(min);
      expect(plan.action).toBe('analyse');
      if (plan.action !== 'analyse') continue;
      expect(plan.estimatedTokens).toBeLessThanOrEqual(ANALYSIS_TOKEN_CAP);
      const seconds = plan.endSec ?? min * 60;
      expect(videoTokens(seconds, plan.fps)).toBeLessThanOrEqual(ANALYSIS_TOKEN_CAP);
    }
  });

  it('matches the smoke outliers: the 62- and 69-minute talks are skipped, the 29-minute one runs at a lower frame rate', () => {
    expect(videoPlan(69)).toEqual({ action: 'skip', reason: 'video is 69 min, over 60' });
    expect(videoPlan(62)).toMatchObject({ action: 'skip' });
    expect(videoPlan(29)).toMatchObject({ action: 'analyse', fps: 0.5, endSec: null, clipped: false });
    expect(videoPlan(12)).toMatchObject({ action: 'analyse', fps: 1, clipped: false });
    expect(videoPlan(180)).toMatchObject({ action: 'skip' });
    expect(videoPlan(null)).toEqual({ action: 'skip', reason: 'unknown video length' });
  });

  it('clips a video that does not fit even at the lowest frame rate', () => {
    const plan = videoPlan(60);
    expect(plan).toMatchObject({ action: 'analyse', fps: 0.25, clipped: true });
    expect(plan.action === 'analyse' ? plan.endSec : 0).toBeLessThan(3600);
  });

  it('keeps text far inside the cap, and discovery never collects videos over 60 minutes', () => {
    expect(textTokens(MAX_TEXT_CHARS)).toBeLessThan(ANALYSIS_TOKEN_CAP / 5);
    for (const stage of STAGES) expect(poolPlan('Topic', stage).maxVideoMin).toBeLessThanOrEqual(VIDEO_MAX_MIN);
  });
});
