import { Global, Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ReadinessRegistry } from '../common/health';
import { AppConfig } from '../config';
import { describeError } from './redact';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
export const DATABASE = Symbol('DATABASE');
export const PG_POOL = Symbol('PG_POOL');

/** Pool settings for Neon free: few connections, short idle so compute can suspend (PRD-API §3). */
export function poolConfig(config: AppConfig): ConstructorParameters<typeof Pool>[0] {
  const { DATABASE_URL, DATABASE_SCHEMA } = config.env;
  return {
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // The pooled Neon endpoint rejects startup options, so only per-run test schemas set one.
    ...(DATABASE_SCHEMA === 'public' ? {} : { options: `-c search_path="${DATABASE_SCHEMA}",public` }),
  };
}

@Global()
@Module({
  providers: [
    { provide: PG_POOL, inject: [AppConfig], useFactory: (config: AppConfig) => new Pool(poolConfig(config)) },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [DATABASE],
})
export class DbModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DbModule.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly readiness: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.pool.on('error', (error) => {
      this.logger.error(`Idle database client error: ${describeError(error)}`);
    });
    this.readiness.register('db', () => this.pool.query('SELECT 1'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
