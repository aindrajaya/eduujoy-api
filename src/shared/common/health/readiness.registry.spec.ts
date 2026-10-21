import { ReadinessRegistry } from './readiness.registry';

describe('ReadinessRegistry', () => {
  it('is ready when no checks are registered', async () => {
    await expect(new ReadinessRegistry().run()).resolves.toEqual({ ready: true, checks: {} });
  });

  it('reports each check as ok or fail', async () => {
    const registry = new ReadinessRegistry();
    registry.register('db', () => Promise.resolve());
    registry.register('vendor', () => Promise.reject(new Error('connection refused to postgres://u:p@h')));

    const result = await registry.run();

    expect(result).toEqual({ ready: false, checks: { db: 'ok', vendor: 'fail' } });
  });

  it('fails a check that exceeds the timeout', async () => {
    const registry = new ReadinessRegistry(20);
    registry.register('slow', () => new Promise((resolve) => setTimeout(resolve, 200)));

    await expect(registry.run()).resolves.toEqual({ ready: false, checks: { slow: 'timeout' } });
  });

  it('rejects duplicate names', () => {
    const registry = new ReadinessRegistry();
    registry.register('db', () => Promise.resolve());

    expect(() => {
      registry.register('db', () => Promise.resolve());
    }).toThrow('db');
  });
});
