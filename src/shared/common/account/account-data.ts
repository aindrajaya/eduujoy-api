import { type Tx } from '../../db';

/**
 * One module's part of a learner's personal data (A13, GDPR-level export and deletion, PRD-API §12).
 * `export` returns plain JSON of that learner's rows only, never secrets (hashes, tokens, answer keys).
 * `erase` runs inside the deletion transaction before the user row is deleted; rows that cascade or
 * set null on the user's foreign key need no erase step.
 */
export interface AccountDataContributor {
  readonly section: string;
  export(userId: string): Promise<unknown>;
  erase?(tx: Tx, userId: string, tombstone: string): Promise<void>;
}
