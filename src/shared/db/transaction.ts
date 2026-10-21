import { type Database } from './database';

/** A Drizzle transaction handle (what db.transaction passes to its callback). */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Repositories accept either, so the same code runs standalone or inside a caller's transaction. */
export type DbExecutor = Database | Tx;
