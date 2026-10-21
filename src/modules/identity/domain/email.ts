/** Emails are stored and compared lowercased; the unique index is on lower(email) as a backstop. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
