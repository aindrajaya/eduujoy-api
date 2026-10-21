import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { type PasswordHasher } from '../application/ports/crypto';

// OWASP Password Storage Cheat Sheet minimum for argon2id: 19 MiB memory, 2 iterations, 1 lane.
// The algorithm is node-rs's default, Argon2id (its enum is const and unusable with isolatedModules);
// the spec pins the encoded `$argon2id$v=19$m=19456,t=2,p=1$` prefix.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export class Argon2PasswordHasher implements PasswordHasher {
  private readonly dummy: Promise<string> = hash(randomBytes(16).toString('hex'), OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(hashed: string, password: string): Promise<boolean> {
    try {
      return await verify(hashed, password);
    } catch {
      return false;
    }
  }

  async verifyDummy(password: string): Promise<void> {
    await this.verify(await this.dummy, password);
  }
}
