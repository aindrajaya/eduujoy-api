import { Argon2PasswordHasher } from './argon2-password.hasher';
import { HmacSecretHasher } from './hmac-secret.hasher';

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('hashes with argon2id at the OWASP parameters and verifies', async () => {
    const hashed = await hasher.hash('correct horse battery');

    expect(hashed.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    await expect(hasher.verify(hashed, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(hashed, 'wrong horse battery')).resolves.toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hasher.hash('same password')).not.toBe(await hasher.hash('same password'));
  });

  it('treats a malformed stored hash as a mismatch instead of throwing', async () => {
    await expect(hasher.verify('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('runs a dummy verification for unknown accounts', async () => {
    await expect(hasher.verifyDummy('anything')).resolves.toBeUndefined();
  });
});

describe('HmacSecretHasher', () => {
  const hasher = new HmacSecretHasher('p'.repeat(64));

  it('issues 256-bit url-safe refresh tokens and stores only their hash', () => {
    const { token, hash } = hasher.newRefreshToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain(token);
    expect(hasher.hashRefreshToken(token)).toBe(hash);
  });

  it('depends on the pepper and separates purposes', () => {
    const other = new HmacSecretHasher('q'.repeat(64));

    expect(other.hashRefreshToken('t')).not.toBe(hasher.hashRefreshToken('t'));
    expect(hasher.hashIp('t')).not.toBe(hasher.hashRefreshToken('t'));
  });
});
