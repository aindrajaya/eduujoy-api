import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type PromptRef } from '../ports';

export class PromptNotFoundError extends Error {
  override name = 'PromptNotFoundError';
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_FILE = /^v(\d{1,4})\.md$/;

/** Default location: src/prompts in development, dist/prompts in the build (Nest CLI asset). */
export const DEFAULT_PROMPTS_DIR = join(__dirname, '..', '..', '..', 'prompts');

/**
 * Versioned prompts from `<dir>/<name>/v<n>.md` (PRD-API §11). Loaded once; every call records the
 * name and version it used in llm_calls.
 */
export class PromptRegistry {
  private readonly prompts = new Map<string, Map<number, string>>();

  constructor(dir: string = DEFAULT_PROMPTS_DIR) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const folder = join(dir, name);
      if (!NAME.test(name) || !statSync(folder).isDirectory()) continue;
      const versions = new Map<number, string>();
      for (const file of readdirSync(folder)) {
        const match = VERSION_FILE.exec(file);
        if (match?.[1]) versions.set(Number(match[1]), readFileSync(join(folder, file), 'utf8').trim());
      }
      if (versions.size > 0) this.prompts.set(name, versions);
    }
  }

  names(): string[] {
    return [...this.prompts.keys()].sort();
  }

  /** A specific version (`v2`), or the highest version when none is given. */
  get(name: string, version?: string): PromptRef {
    const versions = this.prompts.get(name);
    if (!versions) throw new PromptNotFoundError(`Unknown prompt "${name}"`);
    const number = version === undefined ? Math.max(...versions.keys()) : Number(/^v(\d+)$/.exec(version)?.[1]);
    const text = versions.get(number);
    if (text === undefined) throw new PromptNotFoundError(`Prompt "${name}" has no version ${version ?? ''}`.trim());
    return { name, version: `v${number}`, text };
  }
}
