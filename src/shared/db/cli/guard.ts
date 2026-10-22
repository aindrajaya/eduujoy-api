import { type Client, type Pool } from 'pg';
import { describeError } from '../redact';

/**
 * Every pg Client or Pool outside the app's DbModule needs an 'error' listener: a dropped Neon connection
 * makes pg emit 'error', and with no listener Node throws it as an uncaught exception that kills the
 * process (A8 smoke, 23 Oct 2026: "read ETIMEDOUT" → "Unhandled 'error' event"). With this, the drop is
 * logged (redacted) and the in-flight query rejects, so the caller fails cleanly; a Pool also replaces
 * the dropped connection for later queries.
 */
export function guardConnection<T extends Client | Pool>(connection: T, label: string, write: (line: string) => void = (line) => process.stderr.write(line)): T {
  (connection as Pool).on('error', (error: Error) => {
    write(`${label}: database connection error: ${describeError(error)}\n`);
  });
  return connection;
}
