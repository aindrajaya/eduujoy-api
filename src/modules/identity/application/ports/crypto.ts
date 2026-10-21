export const PASSWORD_HASHER = Symbol('PasswordHasher');
export const SECRET_HASHER = Symbol('SecretHasher');
export const IDENTITY_CLOCK = Symbol('IdentityClock');

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /** Burns the same time as `verify` so unknown emails can't be detected by timing. */
  verifyDummy(password: string): Promise<void>;
}

export interface SecretHasher {
  /** A new opaque refresh token and its peppered hash (only the hash is stored). */
  newRefreshToken(): { token: string; hash: string };
  hashRefreshToken(token: string): string;
  hashIp(ip: string): string;
}

export type Clock = () => Date;
