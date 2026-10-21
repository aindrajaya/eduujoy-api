import { createHmac, randomBytes } from 'node:crypto';
import { type SecretHasher } from '../application/ports/crypto';

/** Refresh tokens are 256-bit random values; the DB stores only HMAC-SHA256(pepper, value). */
export class HmacSecretHasher implements SecretHasher {
  constructor(private readonly pepper: string) {}

  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return this.mac('refresh', token);
  }

  hashIp(ip: string): string {
    return this.mac('ip', ip);
  }

  private mac(purpose: string, value: string): string {
    return createHmac('sha256', this.pepper).update(`${purpose}:${value}`).digest('base64url');
  }
}
