import { Global, Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { ReadinessRegistry } from '../common/health';
import { AppConfig } from '../config';
import { createDatabase, type Database } from './database';
import { describeError } from './redact';

export const DATABASE = Symbol('DATABASE');
export const PG_POOL = Symbol('PG_POOL');

/**
 * Pool settings for Neon free (PRD-API §3; resilience spec request approved by the user, 22 Oct 2026):
 * few connections; idle clients closed after 10 s, well below Neon's idle cutoffs, so the pool rarely
 * hands out a socket Neon already dropped; TCP keep-alive so dead peers are noticed; a bounded connect
 * timeout. Queries are never retried here: a reset mid-query fails, which is correct for writes.
 */
export const POOL_SETTINGS = {
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
} as const;

export function poolConfig(config: AppConfig): ConstructorParameters<typeof Pool>[0] {
  const { DATABASE_URL, DATABASE_SCHEMA } = config.env;
  return {
    connectionString: DATABASE_URL,
    ...POOL_SETTINGS,
    // The pooled Neon endpoint rejects startup options, so only per-run test schemas set one.
    ...(DATABASE_SCHEMA === 'public' ? {} : { options: `-c search_path="${DATABASE_SCHEMA}",public` }),
  };
}

/**
 * pg-pool listens for 'error' only on idle clients; a client checked out for a query or transaction has
 * no listener, so a connection Neon drops mid-query was an uncaught exception that killed the process
 * (found 23 Oct 2026 after the A8 smoke crash). Every physical client gets a permanent listener when the
 * pool creates it: the drop is logged and the in-flight query rejects; the pool discards the client.
 */
export function guardPool(pool: Pool, log: (message: string) => void): Pool {
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      log(`Database client error: ${describeError(error)}`);
    });
  });
  pool.on('error', (error) => {
    log(`Idle database client error: ${describeError(error)}`);
  });
  return pool;
}

const poolLogger = new Logger('DbPool');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfig],
      // Guarded at creation, so no client can exist without an 'error' listener.
      useFactory: (config: AppConfig) =>
        guardPool(new Pool(poolConfig(config)), (message) => {
          poolLogger.error(message);
        }),
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => createDatabase(pool),
    },
  ],
  exports: [DATABASE],
})
export class DbModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    // Absent in contexts without the HTTP health stack (workers, CLIs); /ready then has nothing to check.
    @Optional() @Inject(ReadinessRegistry) private readonly readiness?: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.readiness?.register('db', () => this.pool.query('SELECT 1'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
