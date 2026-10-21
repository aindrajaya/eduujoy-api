import { Controller, Get, Res, Sse } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { type Response } from 'express';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { createCompression } from './compression';

const BIG = { items: Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}`, label: 'a repetitive label' })) };

@Controller()
class FixtureController {
  @Get('big')
  big() {
    return BIG;
  }

  @Get('small')
  small() {
    return { ok: true };
  }

  @Sse('events')
  events() {
    return of({ data: BIG });
  }

  // A hand-written stream without Nest's `Cache-Control: no-transform`, like the job events route.
  @Get('raw-events')
  rawEvents(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.end(`data: ${JSON.stringify(BIG)}\n\n`);
  }
}

describe('createCompression', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [FixtureController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(createCompression());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['br', 'gzip'])('compresses a response above 1 KB with %s when the client asks for it', async (encoding) => {
    const res = await request(app.getHttpServer()).get('/big').set('Accept-Encoding', encoding).expect(200);

    expect(res.headers['content-encoding']).toBe(encoding);
    expect(res.headers.vary).toMatch(/Accept-Encoding/i);
    expect(res.body).toEqual(BIG);
  });

  it('prefers brotli when the client accepts both', async () => {
    const res = await request(app.getHttpServer()).get('/big').set('Accept-Encoding', 'gzip, deflate, br').expect(200);

    expect(res.headers['content-encoding']).toBe('br');
  });

  it('leaves small responses and clients without Accept-Encoding uncompressed', async () => {
    const small = await request(app.getHttpServer()).get('/small').set('Accept-Encoding', 'gzip, br').expect(200);
    const identity = await request(app.getHttpServer()).get('/big').set('Accept-Encoding', 'identity').expect(200);

    expect(small.headers['content-encoding']).toBeUndefined();
    expect(identity.headers['content-encoding']).toBeUndefined();
  });

  it.each(['/events', '/raw-events'])('never compresses server-sent events (%s)', async (path) => {
    const res = await request(app.getHttpServer()).get(path).set('Accept-Encoding', 'gzip, br').buffer(true).parse((r, done) => {
      let text = '';
      r.on('data', (chunk: Buffer) => {
        text += chunk.toString();
      });
      r.on('end', () => {
        done(null, text);
      });
    });

    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(String(res.body)).toContain('item-99');
  });
});
