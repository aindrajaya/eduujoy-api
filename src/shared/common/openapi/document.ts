import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { PROBLEM_SCHEMAS } from './schemas';

/** The frozen contract version this build implements (docs/contract/openapi.v0.yaml). */
export const CONTRACT_VERSION = '0.2.1-v0';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/** Input DTOs reject unknown fields (ValidationPipe forbidNonWhitelisted), so say so in the schema. */
function closeRequestSchemas(document: OpenAPIObject): void {
  const schemas = document.components?.schemas ?? {};
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item as Record<string, { requestBody?: unknown }>)) {
      const content = (operation.requestBody as { content?: Record<string, { schema?: { $ref?: string } }> } | undefined)
        ?.content;
      for (const media of Object.values(content ?? {})) {
        const name = media.schema?.$ref?.split('/').pop();
        const schema = name ? schemas[name] : undefined;
        if (schema && !('$ref' in schema)) schema.additionalProperties = false;
      }
    }
  }
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle('Eduujoy API')
    .setVersion(CONTRACT_VERSION)
    .setDescription('Generated from the NestJS app; checked against docs/contract/openapi.v0.yaml by `pnpm openapi:check`.')
    .addServer('https://api.eduujoy.aindrajaya.my.id', 'Production (Koyeb)')
    .addServer('http://localhost:3000', 'Local')
    .addCookieAuth('ej_at', { type: 'apiKey', in: 'cookie', description: 'Access JWT, 15 min.' }, 'cookieAuth')
    .addCookieAuth('ej_rt', { type: 'apiKey', in: 'cookie', description: 'Opaque refresh token, 30 days, rotated.' }, 'refreshCookie')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...PROBLEM_SCHEMAS },
  };
  closeRequestSchemas(document);
  return sortKeys(document) as OpenAPIObject;
}
