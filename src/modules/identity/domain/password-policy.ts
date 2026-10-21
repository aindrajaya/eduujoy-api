export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export type PasswordCheck = { ok: true } | { ok: false; reason: string };

/** Contract bounds (RegisterRequest), measured in code points so emoji count as one character. */
export function checkPassword(password: string): PasswordCheck {
  // JSON Schema minLength/maxLength count code points, so match that rather than graphemes.
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN) return { ok: false, reason: `password must be at least ${PASSWORD_MIN} characters` };
  if (length > PASSWORD_MAX) return { ok: false, reason: `password must be at most ${PASSWORD_MAX} characters` };
  if (password.trim().length === 0) return { ok: false, reason: 'password must not be blank' };
  return { ok: true };
}
