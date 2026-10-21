import { SignJWT } from 'jose';
import { AccessTokenService } from './access-token.service';

const secret = 's'.repeat(64);
const issuer = 'https://api.example';
const claims = { userId: '0b1c6a1e-7f43-4c3c-9d39-5f2f6a1f0a11', sessionId: 'a7c1b8f0-0e8d-4f0e-9f7a-0d6b1e2c3d4f', roles: ['learner' as const], plan: 'free' as const };

describe('AccessTokenService', () => {
  const service = new AccessTokenService(secret, issuer);

  it('round-trips the session claims', async () => {
    const token = await service.sign(claims);

    await expect(service.verify(token)).resolves.toEqual(claims);
  });

  it('expires tokens after 15 minutes', async () => {
    const issuedAt = new Date('2026-10-21T10:00:00Z');
    const token = await service.sign(claims, issuedAt);

    await expect(service.verify(token, new Date('2026-10-21T10:14:59Z'))).resolves.toEqual(claims);
    await expect(service.verify(token, new Date('2026-10-21T10:15:01Z'))).resolves.toBeNull();
  });

  it('rejects tokens signed with another key, issuer or audience', async () => {
    const other = new AccessTokenService('o'.repeat(64), issuer);
    const otherIssuer = new AccessTokenService(secret, 'https://evil.example');

    await expect(service.verify(await other.sign(claims))).resolves.toBeNull();
    await expect(service.verify(await otherIssuer.sign(claims))).resolves.toBeNull();

    const wrongAudience = await new SignJWT({ sid: claims.sessionId, roles: claims.roles, plan: claims.plan })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(issuer)
      .setAudience('someone-else')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    await expect(service.verify(wrongAudience)).resolves.toBeNull();
  });

  it('rejects unsigned and malformed tokens', async () => {
    const [header, payload] = (await service.sign(claims)).split('.');
    const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');

    await expect(service.verify(`${unsignedHeader}.${payload ?? ''}.`)).resolves.toBeNull();
    await expect(service.verify(`${header ?? ''}.${payload ?? ''}.bad`)).resolves.toBeNull();
    await expect(service.verify('not-a-jwt')).resolves.toBeNull();
  });

  it('rejects tokens whose claims do not match the expected shape', async () => {
    const badRoles = await new SignJWT({ sid: claims.sessionId, roles: ['superuser'], plan: 'free' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(issuer)
      .setAudience('eduujoy-api')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));

    await expect(service.verify(badRoles)).resolves.toBeNull();
  });
});
