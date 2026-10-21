import { parseSeed, SeedValidationError, type SeedFiles } from './seed-data';

const topic = (slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug,
  canonicalName: slug.toUpperCase(),
  aliases: [],
  description: `About ${slug}`,
  domain: 'software',
  parent: null,
  prerequisites: [],
  ...extra,
});

const files = (topics: unknown[], items: Record<string, unknown> = {}): SeedFiles => ({
  topics: { version: 1, topics },
  items,
});

const item = (key: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  stage: 'novice',
  bloom: 'C1',
  kind: 'single_choice',
  prompt: 'What is 2 + 2?',
  options: [
    { id: 'a', label: '3' },
    { id: 'b', label: '4' },
  ],
  answerKey: { optionIds: ['b'] },
  ...extra,
});

describe('parseSeed', () => {
  it('accepts a valid taxonomy with parents, prerequisites and items', () => {
    const seed = parseSeed(
      files([topic('js'), topic('react', { parent: 'js', prerequisites: ['js'] })], {
        react: { version: 1, topic: 'react', items: [item('q1')] },
      }),
    );

    expect(seed.topics.map((t) => t.slug)).toEqual(['js', 'react']);
    expect(seed.items).toEqual([expect.objectContaining({ topic: 'react', key: 'q1', seedKey: 'react:q1' })]);
  });

  it('rejects unknown fields so format drift is caught early', () => {
    expect(() => parseSeed(files([topic('js', { colour: 'red' })]))).toThrow(SeedValidationError);
  });

  it('rejects duplicate slugs', () => {
    expect(() => parseSeed(files([topic('js'), topic('js')]))).toThrow(/duplicate slug "js"/);
  });

  it('rejects a parent or prerequisite that is not in the taxonomy', () => {
    expect(() => parseSeed(files([topic('react', { parent: 'js' })]))).toThrow(/unknown parent "js"/);
    expect(() => parseSeed(files([topic('react', { prerequisites: ['js'] })]))).toThrow(/unknown prerequisite "js"/);
  });

  it('rejects prerequisite cycles, including self-edges', () => {
    expect(() => parseSeed(files([topic('a', { prerequisites: ['a'] })]))).toThrow(/cycle/);
    expect(() =>
      parseSeed(
        files([topic('a', { prerequisites: ['c'] }), topic('b', { prerequisites: ['a'] }), topic('c', { prerequisites: ['b'] })]),
      ),
    ).toThrow(/cycle: a -> c -> b -> a/);
  });

  it('rejects items for unknown topics or whose file name and topic disagree', () => {
    expect(() => parseSeed(files([topic('js')], { css: { version: 1, topic: 'css', items: [item('q1')] } }))).toThrow(
      /unknown topic "css"/,
    );
    expect(() => parseSeed(files([topic('js')], { other: { version: 1, topic: 'js', items: [item('q1')] } }))).toThrow(
      /items\/other.json declares topic "js"/,
    );
  });

  it('requires options for choice items and answer keys that point at real options', () => {
    const noOptions = item('q1', { options: undefined });
    const badKey = item('q2', { answerKey: { optionIds: ['z'] } });
    const twoForSingle = item('q3', { answerKey: { optionIds: ['a', 'b'] } });

    for (const bad of [noOptions, badKey, twoForSingle]) {
      expect(() => parseSeed(files([topic('js')], { js: { version: 1, topic: 'js', items: [bad] } }))).toThrow(
        SeedValidationError,
      );
    }
  });

  it('accepts multiple-choice scenario items with an answer key, and open scenarios without options', () => {
    const scenarioChoice = item('s1', { kind: 'scenario' });
    const openScenario = item('s2', { kind: 'scenario', options: undefined, answerKey: undefined });

    expect(() => parseSeed(files([topic('js')], { js: { version: 1, topic: 'js', items: [scenarioChoice, openScenario] } }))).not.toThrow();
    expect(() =>
      parseSeed(files([topic('js')], { js: { version: 1, topic: 'js', items: [item('s3', { kind: 'scenario', answerKey: undefined })] } })),
    ).toThrow(/multiple-choice scenario/);
    expect(() =>
      parseSeed(files([topic('js')], { js: { version: 1, topic: 'js', items: [item('s4', { kind: 'short_answer' })] } })),
    ).toThrow(/only for choice or scenario/);
  });

  it('rejects duplicate item keys within a topic', () => {
    expect(() =>
      parseSeed(files([topic('js')], { js: { version: 1, topic: 'js', items: [item('q1'), item('q1')] } })),
    ).toThrow(/duplicate item key "q1"/);
  });

  it('lists every problem with its location', () => {
    let message = '';
    try {
      parseSeed(files([topic('Bad Slug'), topic('ok', { domain: 'magic' })]));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/topics\.json topics\.0\.slug/);
    expect(message).toMatch(/topics\.json topics\.1\.domain/);
  });
});
