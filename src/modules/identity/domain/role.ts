export const ROLES = ['learner', 'reviewer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Every new account starts as a learner; reviewer and admin are granted by an admin. */
export const DEFAULT_ROLES: readonly Role[] = ['learner'];
