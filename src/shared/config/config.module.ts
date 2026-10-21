import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig } from './app-config';
import { type Env, parseEnv } from './env';

@Global()
@Module({})
export class ConfigModule {
  /** Validates the environment once at boot; pass `env` to override in tests. */
  static forRoot(env?: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: AppConfig, useFactory: () => new AppConfig(env ?? parseEnv(process.env)) }],
      exports: [AppConfig],
    };
  }
}
