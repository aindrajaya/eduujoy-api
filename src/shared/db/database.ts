import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type Client, type Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(client: Pool | Client): Database {
  return drizzle(client, { schema, casing: 'snake_case' });
}
