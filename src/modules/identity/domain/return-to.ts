/** Where the SPA lands after sign-in when `returnTo` is missing or unsafe. */
export const DEFAULT_RETURN_TO = '/today';
const MAX_LENGTH = 512;

/** C0 controls, DEL, C1 controls and the Unicode line/paragraph separators. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}
const PROBE_ORIGIN = 'https://return-to.invalid';

/**
 * `returnTo` comes straight from the browser, so only a same-site relative path is kept: one leading
 * "/", no "//", no backslash anywhere, no scheme, no control characters. Anything else becomes
 * DEFAULT_RETURN_TO; the API never redirects to an absolute URL taken from input.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return DEFAULT_RETURN_TO;
  if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_RETURN_TO;
  if (value.includes('\\') || hasControlCharacter(value)) return DEFAULT_RETURN_TO;
  // Defence in depth: whatever a URL parser makes of it must stay on the same origin.
  try {
    if (new URL(value, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
  return value;
}

export function isSafeReturnTo(value: unknown): value is string {
  return typeof value === 'string' && safeReturnTo(value) === value;
}
