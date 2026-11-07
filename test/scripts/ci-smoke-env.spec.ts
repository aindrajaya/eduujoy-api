import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSchema, parseEnv } from '../../src/shared/config/env';

const ROOT = join(__dirname, '..', '..');
const LIST = '.github/ci/smoke-env.list';

/** The KEY=VALUE lines docker run --env-file reads (comments and blanks skipped, values taken literally). */
function smokeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, LIST), 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * The docker smoke test (lead gate, 7 Nov 2026) boots the built image with this env list. It failed
 * from 23 Oct because the app gained required variables the step never passed; now a new required
 * variable fails here, in CI, before the image is built.
 */
describe('the docker smoke env list', () => {
  it('passes the app env validation as the image runs it (NODE_ENV=production)', () => {
    expect(() => parseEnv({ ...smokeEnv(), NODE_ENV: 'production' })).not.toThrow();
  });

  it('gives every required variable of the schema a value', () => {
    const shape = envSchema.shape as Record<string, { isOptional(): boolean }>;
    const required = Object.entries(shape)
      .filter(([, field]) => !field.isOptional())
      .map(([key]) => key)
      .filter((key) => key !== 'NODE_ENV');
    // Not vacuous: the schema has well over a dozen required variables today.
    expect(required.length).toBeGreaterThan(15);
    expect(required).toEqual(expect.arrayContaining(['JWT_ACCESS_SECRET', 'LEMONSQUEEZY_MODE', 'DATABASE_URL']));
    expect(required.filter((key) => !(key in smokeEnv()))).toEqual([]);
  });

  it('holds only obvious placeholders: no real key, host or secret', () => {
    for (const [key, value] of Object.entries(smokeEnv())) {
      const ok = value.startsWith('ci-dummy-') || /^https:\/\/ci-dummy-[a-z-]+\.example(\/|$)/.test(value) || /^\d{1,3}$/.test(value) || value === 'test' || value === 'postgresql://smoke:smoke@127.0.0.1:5432/smoke';
      expect({ key, ok }).toEqual({ key, ok: true });
    }
  });

  it('is what the docker job runs, with no GitHub secret in the smoke step', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const docker = workflow.slice(workflow.indexOf('  docker:\n'));
    expect(docker).toContain(`--env-file ${LIST}`);
    expect(docker).not.toContain('secrets.');
  });
});
