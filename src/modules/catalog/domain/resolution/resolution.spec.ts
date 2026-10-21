import {
  CHOICE_THRESHOLD,
  clampSimilarity,
  decide,
  fallbackTopicName,
  MATCH_THRESHOLD,
  normaliseTopicText,
  queryText,
  slugify,
  topicDocument,
} from './index';

describe('decide', () => {
  it('uses the thresholds tuned on the golden set', () => {
    expect([MATCH_THRESHOLD, CHOICE_THRESHOLD]).toEqual([0.7, 0.66]);
  });

  it('auto-matches the nearest topic at the match threshold or above', () => {
    expect(decide([{ topicId: 'b', similarity: 0.68 }, { topicId: 'a', similarity: MATCH_THRESHOLD }])).toEqual({ kind: 'matched', topicId: 'a', similarity: MATCH_THRESHOLD });
  });

  it('offers at most 3 choices between the thresholds, nearest first', () => {
    const decision = decide([
      { topicId: 'a', similarity: 0.67 },
      { topicId: 'b', similarity: 0.6999 },
      { topicId: 'c', similarity: CHOICE_THRESHOLD },
      { topicId: 'd', similarity: 0.68 },
      { topicId: 'e', similarity: 0.6599 },
    ]);

    expect(decision).toEqual({
      kind: 'choices',
      choices: [
        { topicId: 'b', similarity: 0.6999 },
        { topicId: 'd', similarity: 0.68 },
        { topicId: 'a', similarity: 0.67 },
      ],
    });
  });

  it('creates below the choice threshold and when there are no candidates', () => {
    expect(decide([{ topicId: 'a', similarity: 0.6599 }])).toEqual({ kind: 'create' });
    expect(decide([])).toEqual({ kind: 'create' });
  });

  it('breaks similarity ties by id so results are stable', () => {
    expect(decide([{ topicId: 'z', similarity: 0.8 }, { topicId: 'a', similarity: 0.8 }])).toMatchObject({ topicId: 'a' });
  });
});

describe('topic text', () => {
  it('normalises case, width, spacing and surrounding punctuation for exact matches', () => {
    expect(normaliseTopicText('  React   Hooks?! ')).toBe('react hooks');
    expect(normaliseTopicText('"ＲＥＳＴ APIs"')).toBe('rest apis');
    expect(normaliseTopicText('C++')).toBe('c++');
  });

  it('slugifies names, keeping C++ and C# distinct', () => {
    expect(slugify('Machine Learning: The Basics')).toBe('machine-learning-the-basics');
    expect(slugify('C++')).toBe('cpp');
    expect(slugify('C#')).toBe('csharp');
    expect(slugify('Café crème')).toBe('cafe-creme');
    expect(slugify('!!!')).toBe('topic');
    expect(slugify('a'.repeat(100)).length).toBe(80);
  });

  it('embeds the learner text with spacing collapsed but case kept', () => {
    expect(queryText('  Learn   React\tHooks ')).toBe('Learn React Hooks');
  });

  it('builds a fallback display name from learner text', () => {
    expect(fallbackTopicName('  sourdough   baking ')).toBe('Sourdough baking');
  });

  it('embeds name, aliases and description', () => {
    expect(topicDocument({ canonicalName: 'React hooks', aliases: ['hooks', 'useState'], description: 'State in function components.' })).toEqual({
      title: 'React hooks',
      text: 'React hooks. Also known as: hooks, useState. State in function components.',
    });
    expect(topicDocument({ canonicalName: 'Go', aliases: [], description: null }).text).toBe('Go');
  });

  it('clamps similarity into [0, 1] at 4 decimals', () => {
    expect(clampSimilarity(1.0000001)).toBe(1);
    expect(clampSimilarity(-0.2)).toBe(0);
    expect(clampSimilarity(0.876543)).toBe(0.8765);
  });
});
