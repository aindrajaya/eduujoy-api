import { join } from 'node:path';
import { PromptNotFoundError, PromptRegistry } from './prompt-registry';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'prompts');

describe('PromptRegistry', () => {
  const registry = new PromptRegistry(FIXTURES);

  it('loads prompt folders and ignores files that are not v<n>.md', () => {
    expect(registry.names()).toEqual(['grader', 'path-designer']);
  });

  it('returns the highest version by number, not by string order', () => {
    expect(registry.get('grader')).toEqual({ name: 'grader', version: 'v10', text: 'Grade v10' });
  });

  it('returns a pinned version', () => {
    expect(registry.get('grader', 'v2')).toEqual({ name: 'grader', version: 'v2', text: 'Grade the answer against the rubric. v2' });
  });

  it('fails loudly for unknown prompts and versions', () => {
    expect(() => registry.get('nope')).toThrow(PromptNotFoundError);
    expect(() => registry.get('grader', 'v7')).toThrow(PromptNotFoundError);
    expect(() => registry.get('grader', 'latest')).toThrow(PromptNotFoundError);
  });

  it('is empty when the directory does not exist (prompts arrive with the credit sprint)', () => {
    expect(new PromptRegistry(join(FIXTURES, 'missing')).names()).toEqual([]);
  });
});
