import { Controller, Post } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { ApiBudgetExceeded } from './decorators';

@Controller('sample')
class SampleController {
  @Post()
  @ApiBudgetExceeded()
  create(): void {
    return undefined;
  }
}

describe('ApiBudgetExceeded', () => {
  it('documents the 503 problem with a Retry-After response header (contract 0.2.1-v0 BudgetExceeded)', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [SampleController] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    await app.close();

    const response = doc.paths['/sample']?.post?.responses['503'] as {
      headers?: Record<string, { schema?: unknown }>;
      content?: Record<string, unknown>;
    };
    expect(response.headers?.['Retry-After']?.schema).toEqual({ type: 'integer', minimum: 1 });
    expect(Object.keys(response.content ?? {})).toEqual(['application/problem+json']);
  });
});
