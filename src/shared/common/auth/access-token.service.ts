import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const AUDIENCE = 'eduujoy-api';
const ALGORITHM = 'HS256';

const roleSchema = z.enum(['learner', 'reviewer', 'admin']);
const payloadSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  roles: z.array(roleSchema).min(1),
  plan: z.enum(['free', 'subscription']),
});

export type AuthRole = z.infer<typeof roleSchema>;
export interface AccessClaims {
  userId: string;
  sessionId: string;
  roles: AuthRole[];
  plan: 'free' | 'subscription';
}

/** Signs and verifies the `ej_at` access JWT (PRD-API §6). Verification never throws. */
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly issuer: string,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: AccessClaims, now = new Date()): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT({ sid: claims.sessionId, roles: claims.roles, plan: claims.plan })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.key);
  }

  async verify(token: string, now = new Date()): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        issuer: this.issuer,
        audience: AUDIENCE,
        currentDate: now,
        clockTolerance: 0,
      });
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success) return null;
      const { sub, sid, roles, plan } = parsed.data;
      return { userId: sub, sessionId: sid, roles, plan };
    } catch (error) {
      if (error instanceof errors.JOSEError || error instanceof TypeError) return null;
      throw error;
    }
  }
}
