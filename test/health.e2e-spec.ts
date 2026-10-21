import request from 'supertest';
import { ReadinessRegistry } from '../src/shared/common/health';
import { createTestApp, type TestApp } from './app';

describe('health (e2e)', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health returns 200 with status and version', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', version: 'e2e' });
  });

  it('GET /ready returns 200 with the database check when it is reachable', async () => {
    const res = await request(app.getHttpServer()).get('/ready').expect(200);

    expect(res.body).toEqual({ status: 'ok', version: 'e2e', checks: { db: 'ok' } });
  });

  it('GET /ready returns 503 problem+json when a check fails', async () => {
    app.get(ReadinessRegistry).register('probe', () => Promise.reject(new Error('down')));

    const res = await request(app.getHttpServer())
      .get('/ready')
      .set('X-Request-Id', 'req-ready-1')
      .expect(503)
      .expect('Content-Type', /application\/problem\+json/);

    expect(res.body).toEqual({
      type: 'http://localhost:3000/problems/not-ready',
      title: 'Service not ready',
      status: 503,
      detail: 'Failing checks: probe',
      code: 'INTERNAL',
      requestId: 'req-ready-1',
    });
    expect(res.headers['x-request-id']).toBe('req-ready-1');
  });
});
