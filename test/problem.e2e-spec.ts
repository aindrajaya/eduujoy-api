import request from 'supertest';
import { createTestApp, type TestApp } from './app';

describe('problem+json errors (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders an unknown route as a 404 problem with the request id', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/nope?token=secret')
      .set('X-Request-Id', 'req-404')
      .expect(404)
      .expect('Content-Type', /application\/problem\+json/);

    expect(res.body).toEqual({
      type: 'http://localhost:3000/problems/not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      requestId: 'req-404',
      instance: '/v1/nope',
    });
  });
});
