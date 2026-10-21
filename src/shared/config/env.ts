import { z } from 'zod';

const originList = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((entry) => entry.trim().replace(/\/+$/, ''))
      .filter((entry) => entry.length > 0),
  )
  .pipe(
    z
      .array(
        z.url({ protocol: /^https?$/ }).refine((value) => new URL(value).origin === value, {
          message: 'must be a bare origin (scheme, host and optional port)',
        }),
      )
      .min(1),
  );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    APP_ORIGIN: originList,
    APP_VERSION: z.string().regex(/^[\w.+-]{1,64}$/).optional(),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/, { error: 'must be a postgres:// connection string' }),
    DATABASE_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/)
      .default('public'),
    JWT_ACCESS_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }),
    REFRESH_TOKEN_PEPPER: z.string().min(32, { error: 'must be at least 32 characters' }),
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
    GOOGLE_OAUTH_REDIRECT_URI: z.url({ protocol: /^https?$/ }),
    ANTHROPIC_API_KEY: z.string().min(1),
    GEMINI_API_KEY: z.string().min(1),
    // Daily AI spend cap in US$ (PRD-API §5); no default, so the operator must choose it.
    AI_DAILY_BUDGET_USD: z.coerce.number().positive().max(1000),
    API_PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, '')),
    // Billing (A12, FR-23). LEMONSQUEEZY_MODE has no default: a test-mode event must never credit in a
    // live deployment, or the other way round, so the operator states which one this is.
    LEMONSQUEEZY_API_KEY: z.string().min(1),
    LEMONSQUEEZY_STORE_ID: z.string().regex(/^\d{1,12}$/, { error: 'must be a numeric store id' }),
    LEMONSQUEEZY_WEBHOOK_SECRET: z.string().min(16, { error: 'must be at least 16 characters' }),
    LEMONSQUEEZY_VARIANT_SUBSCRIPTION: z.string().regex(/^\d{1,12}$/, { error: 'must be a numeric variant id' }),
    LEMONSQUEEZY_VARIANT_CREDIT_PACK: z.string().regex(/^\d{1,12}$/, { error: 'must be a numeric variant id' }),
    LEMONSQUEEZY_MODE: z.enum(['test', 'live']),
  })
  .superRefine((env, ctx) => {
    if (env.LEMONSQUEEZY_VARIANT_SUBSCRIPTION === env.LEMONSQUEEZY_VARIANT_CREDIT_PACK) {
      ctx.addIssue({ code: 'custom', path: ['LEMONSQUEEZY_VARIANT_CREDIT_PACK'], message: 'must differ from the subscription variant' });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.APP_ORIGIN.some((origin) => !origin.startsWith('https://'))) {
      ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'must use https in production' });
    }
    if (!env.API_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['API_PUBLIC_URL'], message: 'must use https in production' });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Thrown at boot when the environment is invalid. Lists key names only, never values. */
export class EnvValidationError extends Error {
  constructor(
    readonly keys: string[],
    details: string[],
  ) {
    super(`Invalid environment: ${details.join('; ')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const keys = new Set<string>();
  const details: string[] = [];
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '(root)');
    keys.add(key);
    const missing = issue.code === 'invalid_type' && source[key] === undefined;
    details.push(`${key}: ${missing ? 'missing' : issue.message}`);
  }
  throw new EnvValidationError([...keys].sort(), details);
}
