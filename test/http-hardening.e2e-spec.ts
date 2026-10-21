import request from 'supertest';
import { createTestApp, type TestApp } from './app';

describe('HTTP hardening (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets helmet security headers and hides X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('mints a request id when none is sent', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows an APP_ORIGIN origin with credentials and exposes X-Request-Id', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://eduujoy.aindrajaya.my.id')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('https://eduujoy.aindrajaya.my.id');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe('X-Request-Id');
  });

  it('answers a preflight from an allowed origin with the allowed methods and headers', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-requested-with')
      .expect(204);

    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PATCH,DELETE');
    expect(res.headers['access-control-allow-headers']).toContain('X-Requested-With');
  });

  it('does not grant CORS to an unknown origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://evil.example')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects JSON bodies over 256 KB with 413', async () => {
    const body = JSON.stringify({ blob: 'x'.repeat(256 * 1024) });

    await request(app.getHttpServer())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(413)
      .expect('Content-Type', /application\/problem\+json/);
  });

  it('rejects malformed JSON with a 400 problem', async () => {
    const res = await request(app.getHttpServer())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"a": ')
      .expect(400)
      .expect('Content-Type', /application\/problem\+json/);

    expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected|JSON at position/);
  });
});
