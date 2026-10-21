import { type OpenAPIObject } from '@nestjs/swagger';

type AnySchema = NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string];
/** A non-$ref OpenAPI schema object, derived from @nestjs/swagger's public types. */
export type SchemaObject = Exclude<AnySchema, { $ref: string }>;
