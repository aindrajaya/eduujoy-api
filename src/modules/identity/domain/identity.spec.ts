import { normalizeEmail } from './email';
import { lockoutStatus, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MS } from './lockout';
import { checkPassword } from './password-policy';
import { decideRefresh, REFRESH_GRACE_MS, type SessionState } from './refresh-rotation';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });
});

describe('checkPassword', () => {
  it('accepts 10 to 128 characters', () => {
    expect(checkPassword('a'.repeat(10))).toEqual({ ok: true });
    expect(checkPassword('a'.repeat(128))).toEqual({ ok: true });
  });

  it('rejects short, long or blank passwords with a reason', () => {
    expect(checkPassword('short')).toEqual({ ok: false, reason: 'password must be at least 10 characters' });
    expect(checkPassword('a'.repeat(129))).toEqual({ ok: false, reason: 'password must be at most 128 characters' });
    expect(checkPassword(' '.repeat(12))).toEqual({ ok: false, reason: 'password must not be blank' });
  });

  it('counts characters, not UTF-16 units', () => {
    expect(checkPassword('🔑'.repeat(10))).toEqual({ ok: true });
    expect(checkPassword('🔑'.repeat(9))).toMatchObject({ ok: false });
  });
});

describe('lockoutStatus', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  const ago = (ms: number): Date => new Date(now.getTime() - ms);

  it('is open below the failure limit', () => {
    const failures = Array.from({ length: LOCKOUT_MAX_FAILURES - 1 }, (_, i) => ago(i * 1000));

    expect(lockoutStatus(failures, now)).toEqual({ locked: false });
  });

  it('locks at 10 failures in 15 minutes until the oldest one leaves the window', () => {
    const failures = Array.from({ length: LOCKOUT_MAX_FAILURES }, (_, i) => ago(60_000 + i * 1000));

    expect(lockoutStatus(failures, now)).toEqual({ locked: true, retryAfterSeconds: 15 * 60 - 69 });
  });

  it('ignores failures outside the window', () => {
    const failures = Array.from({ length: 20 }, () => ago(LOCKOUT_WINDOW_MS + 1));

    expect(lockoutStatus(failures, now)).toEqual({ locked: false });
  });
});

describe('decideRefresh', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  const active: SessionState = { expiresAt: new Date(now.getTime() + 1000), revokedAt: null, replacedBy: null };

  it('rotates an active, unexpired session', () => {
    expect(decideRefresh(active, now)).toBe('rotate');
  });

  it('rejects an expired session', () => {
    expect(decideRefresh({ ...active, expiresAt: now }, now)).toBe('expired');
  });

  it('rejects a revoked session (logout or family revocation)', () => {
    expect(decideRefresh({ ...active, revokedAt: now }, now)).toBe('revoked');
  });

  it('treats a rotated token presented again as reuse', () => {
    const rotated = { ...active, replacedBy: 'next', revokedAt: new Date(now.getTime() - REFRESH_GRACE_MS - 1) };

    expect(decideRefresh(rotated, now)).toBe('reuse');
  });

  it('tolerates a concurrent refresh within the grace window without revoking the family', () => {
    const justRotated = { ...active, replacedBy: 'next', revokedAt: new Date(now.getTime() - 1000) };

    expect(decideRefresh(justRotated, now)).toBe('concurrent');
  });
});
