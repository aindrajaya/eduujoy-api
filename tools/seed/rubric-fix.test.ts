import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keySentencesKept, numberRubric, rebuildRubric, splitSentences, staleWords } from './rubric-fix';

// Run with `pnpm seed:test`.

void describe('rubric sentences', () => {
  const rubric = ['The key is right because 19.6 N = rho g V.  Option text about doubling is a slip.', 'Distractors drop g.'];

  void it('splits into sentences and rebuilds byte for byte when nothing changes', () => {
    const { sentences, separators } = splitSentences(rubric[0] ?? '');
    assert.deepEqual(sentences, ['The key is right because 19.6 N = rho g V.', 'Option text about doubling is a slip.']);
    assert.deepEqual(separators, ['  ']);
    assert.deepEqual(rebuildRubric(rubric, [0], []), rubric);
  });

  void it('rewrites and deletes only non-key sentences, keeping the key sentence exact', () => {
    const out = rebuildRubric(rubric, [0], [{ index: 1, text: 'Two and a half beats adds half the dot twice.' }, { index: 2, text: '' }]);
    assert.deepEqual(out, ['The key is right because 19.6 N = rho g V.  Two and a half beats adds half the dot twice.']);
    assert.ok(keySentencesKept(rubric, out, [0]));
    assert.equal(numberRubric(rubric).length, 3);
  });

  void it('refuses to update a key sentence', () => {
    assert.throws(() => rebuildRubric(rubric, [0], [{ index: 0, text: 'changed' }]), /key sentence/);
  });
});

void describe('staleWords', () => {
  const before = {
    key: 'k',
    prompt: 'How long does a dotted half note last?',
    options: [
      { id: 'a', label: 'Three beats' },
      { id: 'b', label: 'Two beats, doubling the value' },
    ],
    answerKey: { optionIds: ['a'] },
  };
  const now = { prompt: before.prompt, options: [{ id: 'a', label: 'Three beats' }, { id: 'b', label: 'Two and a half beats' }] };

  void it('finds rubric words from a removed distractor wording', () => {
    assert.deepEqual(staleWords(before, { ...now, rubric: ['Two beats confuses the dot with doubling the value.'] }), ['doubl', 'value']);
  });

  void it('passes a rubric that only uses current wording', () => {
    assert.deepEqual(staleWords(before, { ...now, rubric: ['Two and a half beats adds the dot to only half the note.'] }), []);
  });
});
