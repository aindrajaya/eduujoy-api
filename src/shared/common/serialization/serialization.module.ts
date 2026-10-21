import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';

/**
 * PRD-API §7: responses are explicit DTO classes. Each route names its class with
 * @SerializeOptions({ type }); only @Expose()d fields survive, so a stray column never leaks.
 */
@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      inject: [Reflector],
      useFactory: (reflector: Reflector) =>
        new ClassSerializerInterceptor(reflector, { excludeExtraneousValues: true, enableImplicitConversion: false }),
    },
  ],
})
export class SerializationModule {}
