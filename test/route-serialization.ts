import { type INestApplication } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { CLASS_SERIALIZER_OPTIONS } from '@nestjs/common/serializer/class-serializer.constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';

const NO_BODY_STATUSES = new Set([204, 304]);

/**
 * Routes that return a body but don't declare @SerializeOptions({ type }) on the method or class.
 * Exempt: 204/304 routes and handlers that write the response themselves (@Res() without passthrough).
 */
export function routesMissingResponseDto(app: INestApplication): string[] {
  const scanner = new MetadataScanner();
  const missing: string[] = [];
  const controllers = [...app.get(ModulesContainer).values()].flatMap((module) => [...module.controllers.values()]);

  for (const wrapper of controllers) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const metatype = wrapper.metatype as (new (...args: never[]) => unknown) | null;
    if (!instance || !metatype) continue;
    const prototype = Object.getPrototypeOf(instance) as object;
    const classOptions = Reflect.getMetadata(CLASS_SERIALIZER_OPTIONS, metatype) as { type?: unknown } | undefined;

    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

      const status = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
      if (status !== undefined && NO_BODY_STATUSES.has(status)) continue;
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, name) ?? {}) as Record<string, unknown>;
      const injectsResponse = Object.keys(args).some((key) => key.startsWith(`${RouteParamtypes.RESPONSE}:`));
      // Nest records @Res({ passthrough: true }) on the class/method pair, not in the route args.
      const passthrough = Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, metatype, name) === true;
      if (injectsResponse && !passthrough) continue;

      const options = (Reflect.getMetadata(CLASS_SERIALIZER_OPTIONS, handler) ?? classOptions) as { type?: unknown } | undefined;
      if (options?.type === undefined) {
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        missing.push(`${metatype.name}.${name} (method ${method}, path ${String(Reflect.getMetadata(PATH_METADATA, handler))})`);
      }
    }
  }
  return missing.sort();
}
