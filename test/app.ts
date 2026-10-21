import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';

export async function createTestApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  return app;
}
