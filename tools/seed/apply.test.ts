import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lengthCue, verdictAction } from './apply';

// Run with `pnpm seed:test` (tsx --test): the repo's jest roots are src/ and test/, outside tools/seed.

void describe('verdictAction', () => {
  void it('turns a keep with a wrong key into a manual decision', () => {
    assert.equal(verdictAction({ verdict: 'keep', keyCorrect: false }, false), 'needs-manual');
  });

  void it('accepts that keep once the decision is recorded by hand', () => {
    assert.equal(verdictAction({ verdict: 'keep', keyCorrect: false }, true), 'keep');
  });

  void it('passes other verdicts through', () => {
    assert.equal(verdictAction({ verdict: 'keep', keyCorrect: true }, false), 'keep');
    assert.equal(verdictAction({ verdict: 'revise', keyCorrect: false }, false), 'revise');
    assert.equal(verdictAction({ verdict: 'drop', keyCorrect: false }, false), 'drop');
  });
});

void describe('lengthCue', () => {
  const opts = (labels: string[]): { id: string; label: string }[] => labels.map((label, i) => ({ id: String.fromCharCode(97 + i), label }));

  void it('finds a key that is the one longest or one shortest option', () => {
    assert.equal(lengthCue(opts(['a much longer answer', 'short', 'shorter', 'tiny']), ['a']), 'longest');
    assert.equal(lengthCue(opts(['x', 'medium one', 'medium two', 'medium 3']), ['a']), 'shortest');
  });

  void it('reports no cue for a middle-length key, a tie, or a multi-answer item', () => {
    assert.equal(lengthCue(opts(['medium', 'tiny', 'the longest one']), ['a']), null);
    assert.equal(lengthCue(opts(['same', 'same', 'xx']), ['a']), null);
    assert.equal(lengthCue(opts(['a', 'bb']), ['a', 'b']), null);
  });
});
