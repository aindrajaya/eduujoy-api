import { clampSimilarity, decide, fallbackTopicName, normaliseTopicText, slugify, topicDocument } from './index';

describe('decide', () => {
  it('auto-matches the nearest topic at 0.88 or above', () => {
    expect(decide([{ topicId: 'b', similarity: 0.8 }, { topicId: 'a', similarity: 0.88 }])).toEqual({ kind: 'matched', topicId: 'a', similarity: 0.88 });
  });

  it('offers at most 3 choices between 0.75 and 0.88, nearest first', () => {
    const decision = decide([
      { topicId: 'a', similarity: 0.76 },
      { topicId: 'b', similarity: 0.87 },
      { topicId: 'c', similarity: 0.75 },
      { topicId: 'd', similarity: 0.8 },
      { topicId: 'e', similarity: 0.74 },
    ]);

    expect(decision).toEqual({
      kind: 'choices',
      choices: [
        { topicId: 'b', similarity: 0.87 },
        { topicId: 'd', similarity: 0.8 },
        { topicId: 'a', similarity: 0.76 },
      ],
    });
  });

  it('creates below 0.75 and when there are no candidates', () => {
    expect(decide([{ topicId: 'a', similarity: 0.7499 }])).toEqual({ kind: 'create' });
    expect(decide([])).toEqual({ kind: 'create' });
  });

  it('breaks similarity ties by id so results are stable', () => {
    expect(decide([{ topicId: 'z', similarity: 0.9 }, { topicId: 'a', similarity: 0.9 }])).toMatchObject({ topicId: 'a' });
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
