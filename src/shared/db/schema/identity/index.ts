import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { plan, withCreatedAt, withUpdatedAt } from '../common';

export const role = pgEnum('role', ['learner', 'reviewer', 'admin']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name'),
    locale: text('locale').notNull().default('en'),
    plan: plan('plan').notNull().default('free'),
    weeklyHoursDefault: real('weekly_hours_default'),
    passwordHash: text('password_hash'),
    googleSub: text('google_sub'),
    emailVerified: boolean('email_verified').notNull().default(false),
    ...withCreatedAt,
    ...withUpdatedAt,
  },
  (t) => [
    uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`),
    uniqueIndex('users_google_sub_key').on(t.googleSub),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: role('role').notNull(),
    ...withCreatedAt,
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

/** One row per refresh token; rotation links rows in a family so reuse can revoke all of them. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    replacedBy: uuid('replaced_by'),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    ...withCreatedAt,
    /**
     * When the learner signed in (password or Google) to start this family; refresh rotation copies it,
     * so a refresh never renews it. DELETE /v1/me requires it within the last 10 minutes.
     */
    authTime: timestamp('auth_time', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sessions_refresh_hash_key').on(t.refreshHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_family_id_idx').on(t.familyId),
  ],
);

/** Feeds the lockout rule: 10 failed logins in 15 minutes (PRD-API §12). */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    ipHash: text('ip_hash'),
    succeeded: boolean('succeeded').notNull(),
    ...withCreatedAt,
  },
  (t) => [index('login_attempts_email_created_idx').on(sql`lower(${t.email})`, t.createdAt)],
);
