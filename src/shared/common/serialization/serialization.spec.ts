import { Controller, Get, SerializeOptions } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Expose, Type } from 'class-transformer';
import request from 'supertest';
import { SerializationModule } from './serialization.module';

class InnerDto {
  @Expose() keep!: string;
}

class OuterDto {
  @Expose() id!: string;
  @Expose() @Type(() => InnerDto) inner!: InnerDto;
}

@Controller()
class LeakyController {
  @Get('leaky')
  @SerializeOptions({ type: OuterDto })
  leaky(): unknown {
    // A repository row with columns the DTO must not expose.
    return { id: 'u1', passwordHash: 'secret', inner: { keep: 'yes', googleSub: 'sub' } };
  }
}

describe('SerializationModule', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SerializationModule],
      controllers: [LeakyController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('drops every field the response DTO does not expose, including nested ones', async () => {
    const res = await request(app.getHttpServer()).get('/leaky').expect(200);

    expect(res.body).toEqual({ id: 'u1', inner: { keep: 'yes' } });
  });
});
