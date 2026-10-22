import { AppConfig } from '../../config';
import { type Env } from '../../config/env';
import { HealthController } from './health.controller';
import { ReadinessRegistry } from './readiness.registry';

const health = (env: Partial<Env>) => new HealthController(new AppConfig(env as Env), new ReadinessRegistry()).health();

describe('HealthController version', () => {
  it('reports the image APP_VERSION, else Koyeb\'s runtime KOYEB_GIT_SHA, else dev', () => {
    expect(health({ APP_VERSION: 'v1.2.3', KOYEB_GIT_SHA: 'abc1234' }).version).toBe('v1.2.3');
    expect(health({ KOYEB_GIT_SHA: 'a261098c0ffee' }).version).toBe('a261098c0ffee');
    expect(health({}).version).toBe('dev');
  });
});
