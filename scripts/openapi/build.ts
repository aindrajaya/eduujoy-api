import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { type OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from '../../src/app.module';
import { buildOpenApiDocument } from '../../src/shared/common/openapi';

// Fixed, obviously fake values: the export must be deterministic and never see real secrets.
// No database connection is opened (the pool connects lazily and nothing queries it).
const PLACEHOLDER_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_ORIGIN: 'http://localhost:5173',
  API_PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
  JWT_ACCESS_SECRET: 'openapi-export-placeholder-'.padEnd(64, 'x'),
  REFRESH_TOKEN_PEPPER: 'openapi-export-placeholder-'.padEnd(64, 'y'),
  GOOGLE_OAUTH_CLIENT_ID: 'openapi-export.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'openapi-export-placeholder',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/v1/auth/google/callback',
  ANTHROPIC_API_KEY: 'openapi-export-placeholder',
  GEMINI_API_KEY: 'openapi-export-placeholder',
  AI_DAILY_BUDGET_USD: '1',
  LEMONSQUEEZY_API_KEY: 'openapi-export-placeholder',
  LEMONSQUEEZY_STORE_ID: '1',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'openapi-export-placeholder-secret',
  LEMONSQUEEZY_VARIANT_SUBSCRIPTION: '2',
  LEMONSQUEEZY_VARIANT_CREDIT_PACK: '3',
  LEMONSQUEEZY_MODE: 'test',
  YOUTUBE_API_KEY: 'openapi-export-placeholder',
  OPENALEX_API_KEY: 'openapi-export-placeholder',
};

/** Boots the real AppModule (routes, DTOs, decorators) and returns its OpenAPI document. */
export async function buildDocument(): Promise<OpenAPIObject> {
  // ConfigModule validates process.env when the app is created, so setting it here is early enough.
  Object.assign(process.env, PLACEHOLDER_ENV);
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  try {
    return buildOpenApiDocument(app);
  } finally {
    await app.close();
  }
}

export function serialize(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
