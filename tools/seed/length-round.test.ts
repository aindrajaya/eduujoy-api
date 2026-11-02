import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRewrite, clearlyShortest } from './length-round';

// Run with `pnpm seed:test`.

interface Fixture {
  key: string;
  stage: string;
  bloom: string;
  kind: string;
  prompt: string;
  options: { id: string; label: string }[];
  answerKey: { optionIds: string[] };
}

const item = (labels: string[], key = 'a'): Fixture => ({
  key: 'nov-c1-sc1',
  stage: 'novice',
  bloom: 'C1',
  kind: 'single_choice',
  prompt: 'Q?',
  options: labels.map((label, i) => ({ id: String.fromCharCode(97 + i), label })),
  answerKey: { optionIds: [key] },
});

void describe('clearlyShortest', () => {
  void it('needs both the ratio and the gap', () => {
    const opts = item(['A short key', 'A much longer distractor', 'Another longer distractor', 'Third long distractor']).options;
    assert.equal(clearlyShortest(opts, 'a'), true);
    assert.equal(clearlyShortest(item(['abcd', 'abcdef', 'abcdefg', 'abcdefgh']).options, 'a'), false); // ratio ok, gap 2
    assert.equal(clearlyShortest(item(['A key of medium size', 'A distractor slightly long', 'xxxxxxxxxxxxxxxxxxxxxxxxx', 'yyyyyyyyyyyyyyyyyyyyyyyy']).options, 'a'), false);
  });
});

void describe('checkRewrite', () => {
  const original = item(['Short key', 'A much longer distractor here', 'Another long distractor here', 'Third long distractor text']);

  void it('accepts distractors that put the key in the middle', () => {
    assert.deepEqual(checkRewrite(original, [{ id: 'b', label: 'Short no' }, { id: 'c', label: 'A longer option' }, { id: 'd', label: 'Mid option' }]), []);
  });

  void it('rejects a rewrite that leaves the key shortest or makes it longest', () => {
    assert.match(checkRewrite(original, [{ id: 'b', label: 'Still longer one' }, { id: 'c', label: 'Also longer one' }, { id: 'd', label: 'Long again yes' }]).join(), /shortest/);
    assert.match(checkRewrite(original, [{ id: 'b', label: 'No' }, { id: 'c', label: 'Nope' }, { id: 'd', label: 'Nah' }]).join(), /longest/);
  });

  void it('rejects changed ids, empty labels and a distractor that repeats the key', () => {
    assert.match(checkRewrite(original, [{ id: 'x', label: 'Short no' }, { id: 'c', label: 'A longer option' }, { id: 'd', label: 'Mid option' }]).join(), /ids changed/);
    assert.match(checkRewrite(original, [{ id: 'b', label: ' ' }, { id: 'c', label: 'A longer option' }, { id: 'd', label: 'Mid option' }]).join(), /empty/);
    assert.match(checkRewrite(original, [{ id: 'b', label: 'short key' }, { id: 'c', label: 'A longer option' }, { id: 'd', label: 'Mid' }]).join(), /repeats the key/);
  });
});
