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
    API_PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, '')),
  })
  .superRefine((env, ctx) => {
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
