import { type Role } from '../../domain/role';

export const USER_REPOSITORY = Symbol('UserRepository');

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  locale: string;
  weeklyHoursDefault: number | null;
  plan: 'free' | 'subscription';
  passwordHash: string | null;
  googleSub: string | null;
  emailVerified: boolean;
  roles: Role[];
}

export interface NewUser {
  email: string;
  name: string | null;
  passwordHash: string | null;
  googleSub: string | null;
  emailVerified: boolean;
  roles: readonly Role[];
}

/** Thrown by `create` when lower(email) or google_sub is already taken. */
export class DuplicateUserError extends Error {
  override name = 'DuplicateUserError';
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByGoogleSub(sub: string): Promise<UserRecord | null>;
  create(user: NewUser): Promise<UserRecord>;
  /** Attaches a Google identity, marks the email verified and clears any password. */
  linkGoogle(userId: string, sub: string): Promise<UserRecord>;
}
