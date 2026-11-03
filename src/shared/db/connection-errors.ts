/**
 * True when an error means the database connection is gone (A8 pilot, user 3 Nov 2026: a Neon branch
 * deleted mid-run crashed pregen): Postgres admin shutdown or connection-exception codes, socket
 * errors, or pg's own "connection terminated" messages, anywhere in the cause chain (Drizzle wraps the
 * driver error as `cause`). Other query errors (a constraint, bad SQL) are not connection losses.
 */
const PG_CODES = /^(57P0[1-3]|08\d{3})$/;
const NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);
const MESSAGES = /connection terminated|client has encountered a connection error|connection timeout|timeout exceeded when trying to connect|server closed the connection|terminating connection/i;

export function isConnectionLost(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && (PG_CODES.test(e.code) || NODE_CODES.has(e.code))) return true;
    if (typeof e.message === 'string' && MESSAGES.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}
