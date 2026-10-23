import { describeTarget, guardTarget, ProdTargetRefusedError } from './target-guard';

const url = (endpoint: string, pooler = false) => `postgresql://user:secret@${endpoint}${pooler ? '-pooler' : ''}.c-8.eu-central-1.aws.neon.tech/neondb?sslmode=require`;

describe('the CLI target guard (user decision, 23 Oct 2026)', () => {
  it('names the endpoint and region, never the credentials', () => {
    expect(describeTarget(url('ep-cold-dew-ba8tyrlc'))).toEqual({ endpoint: 'ep-cold-dew-ba8tyrlc', region: 'c-8.eu-central-1' });
    expect(describeTarget(url('ep-cold-dew-ba8tyrlc', true)).endpoint).toBe('ep-cold-dew-ba8tyrlc');
    expect(describeTarget('postgresql://u:p@localhost:5432/x')).toEqual({ endpoint: 'localhost', region: 'local' });
    const lines: string[] = [];
    guardTarget(url('ep-cold-dew-ba8tyrlc'), { argv: [], env: {}, write: (l) => lines.push(l) });
    expect(lines).toEqual(['Target database: ep-cold-dew-ba8tyrlc (c-8.eu-central-1)\n']);
    expect(lines.join('')).not.toContain('secret');
  });

  it('refuses prod, pooled or direct, unless --prod is passed', () => {
    const quiet = { env: {}, write: () => undefined };
    expect(() => { guardTarget(url('ep-raspy-recipe-bamuza67'), { ...quiet, argv: ['node', 'migrate.ts'] }); }).toThrow(ProdTargetRefusedError);
    expect(() => { guardTarget(url('ep-raspy-recipe-bamuza67', true), { ...quiet, argv: [] }); }).toThrow(/pass --prod/);
    expect(() => { guardTarget(url('ep-raspy-recipe-bamuza67'), { ...quiet, argv: ['node', 'migrate.ts', '--prod'] }); }).not.toThrow();
  });

  it('marks prod in the printed line and takes extra prod endpoints from the environment', () => {
    const lines: string[] = [];
    guardTarget(url('ep-raspy-recipe-bamuza67'), { argv: ['--prod'], env: {}, write: (l) => lines.push(l) });
    expect(lines[0]).toContain('[PROD]');
    expect(() => { guardTarget(url('ep-new-prod-1'), { argv: [], env: { PROD_DATABASE_ENDPOINTS: 'ep-other, ep-new-prod-1' }, write: () => undefined }); }).toThrow(ProdTargetRefusedError);
    expect(() => { guardTarget(url('ep-new-prod-1'), { argv: [], env: {}, write: () => undefined }); }).not.toThrow();
  });
});
