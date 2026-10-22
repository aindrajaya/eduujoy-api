import { randomUUID } from 'node:crypto';
import { AccessTokenService } from '../../../shared/common/auth/access-token.service';
import { type Clock, type PasswordHasher, type SecretHasher } from './ports/crypto';
import { type LoginAttemptRepository } from './ports/login-attempt.repository';
import { type NewSession, type SessionRecord, type SessionRepository } from './ports/session.repository';
import { DuplicateUserError, type NewUser, type UserRecord, type UserRepository } from './ports/user.repository';
import { SessionIssuer } from './session-issuer';

// In-memory doubles that follow the port contracts; used only by unit tests.

export class FakeUsers implements UserRepository {
  readonly rows = new Map<string, UserRecord>();

  findById(id: string): Promise<UserRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findByEmail(email: string): Promise<UserRecord | null> {
    return Promise.resolve([...this.rows.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null);
  }
  findByGoogleSub(sub: string): Promise<UserRecord | null> {
    return Promise.resolve([...this.rows.values()].find((u) => u.googleSub === sub) ?? null);
  }
  async create(user: NewUser): Promise<UserRecord> {
    if (await this.findByEmail(user.email)) throw new DuplicateUserError();
    const row: UserRecord = { id: randomUUID(), locale: 'en', weeklyHoursDefault: null, plan: 'free', ...user, roles: [...user.roles] };
    this.rows.set(row.id, row);
    return row;
  }
  linkGoogle(userId: string, sub: string): Promise<UserRecord> {
    const row = this.rows.get(userId);
    if (!row) throw new Error('missing user');
    const linked = { ...row, googleSub: sub, emailVerified: true, passwordHash: null };
    this.rows.set(userId, linked);
    return Promise.resolve(linked);
  }
}

export class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, SessionRecord & { refreshHash: string }>();

  create(session: NewSession): Promise<SessionRecord> {
    const row = { id: randomUUID(), ...session, revokedAt: null, replacedBy: null };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }
  findByRefreshHash(hash: string): Promise<SessionRecord | null> {
    return Promise.resolve([...this.rows.values()].find((s) => s.refreshHash === hash) ?? null);
  }
  findById(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  async rotate(previousId: string, next: NewSession, now: Date): Promise<SessionRecord | null> {
    const previous = this.rows.get(previousId);
    if (!previous || previous.replacedBy !== null || previous.revokedAt !== null) return null;
    const created = await this.create(next);
    this.rows.set(previousId, { ...previous, revokedAt: now, replacedBy: created.id });
    return created;
  }
  revoke(id: string, now: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.revokedAt === null) this.rows.set(id, { ...row, revokedAt: now });
    return Promise.resolve();
  }
  async revokeFamily(familyId: string, now: Date): Promise<void> {
    for (const row of this.rows.values()) if (row.familyId === familyId) await this.revoke(row.id, now);
  }
  async revokeAllForUser(userId: string, now: Date): Promise<void> {
    for (const row of this.rows.values()) if (row.userId === userId) await this.revoke(row.id, now);
  }
}

export class FakeAttempts implements LoginAttemptRepository {
  readonly rows: { email: string; succeeded: boolean; at: Date }[] = [];
  constructor(private readonly clock: Clock) {}

  record(email: string, succeeded: boolean): Promise<void> {
    this.rows.push({ email, succeeded, at: this.clock() });
    return Promise.resolve();
  }
  failuresSince(email: string, since: Date): Promise<Date[]> {
    const mine = this.rows.filter((r) => r.email === email && r.at > since);
    const lastSuccess = Math.max(0, ...mine.filter((r) => r.succeeded).map((r) => r.at.getTime()));
    return Promise.resolve(mine.filter((r) => !r.succeeded && r.at.getTime() > lastSuccess).map((r) => r.at));
  }
}

export const fakeHasher: PasswordHasher & { dummyCalls: number } = {
  dummyCalls: 0,
  hash: (password) => Promise.resolve(`hashed:${password}`),
  verify: (hash, password) => Promise.resolve(hash === `hashed:${password}`),
  verifyDummy() {
    this.dummyCalls += 1;
    return Promise.resolve();
  },
};

export const fakeSecrets: SecretHasher = {
  newRefreshToken: () => {
    const token = randomUUID();
    return { token, hash: `h:${token}` };
  },
  hashRefreshToken: (token) => `h:${token}`,
  hashIp: (ip) => `ip:${ip}`,
};

export class TestClock {
  constructor(public now = new Date('2026-10-21T10:00:00Z')) {}
  readonly fn: Clock = () => this.now;
  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

export function testIssuer(sessions: FakeSessions, clock: TestClock): { issuer: SessionIssuer; tokens: AccessTokenService } {
  const tokens = new AccessTokenService('t'.repeat(64), 'https://api.example');
  return { issuer: new SessionIssuer(sessions, fakeSecrets, clock.fn, tokens), tokens };
}
