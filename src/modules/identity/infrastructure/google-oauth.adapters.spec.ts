import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from 'jose';
import { GoogleExchangeError, GoogleOAuthHttpClient } from './google-oauth.client';
import { JoseOAuthStateStore } from './jose-oauth-state.store';

const config = { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'shh', redirectUri: 'http://localhost:3000/v1/auth/google/callback' };

describe('GoogleOAuthHttpClient (contract, offline)', () => {
  let privateKey: KeyLike;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  const idToken = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string } = {}) =>
    new SignJWT({ email: 'ada@example.com', email_verified: true, nonce: 'n-1', name: 'Ada', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('google-sub-1')
      .setIssuer(opts.iss ?? 'https://accounts.google.com')
      .setAudience(opts.aud ?? config.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  function clientReturning(body: unknown, status = 200) {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fetchFn = ((url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as URLSearchParams });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch;
    return { client: new GoogleOAuthHttpClient(config, fetchFn, jwks), calls };
  }

  it('builds an authorization URL with PKCE S256, nonce and the registered redirect URI', () => {
    const url = new URL(new GoogleOAuthHttpClient(config, fetch, jwks).authorizationUrl({ state: 's', codeChallenge: 'cc', nonce: 'n', reauth: false }));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'openid email profile',
      state: 's',
      nonce: 'n',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code with the verifier and returns verified claims', async () => {
    const { client, calls } = clientReturning({ id_token: await idToken({}) });

    await expect(client.exchange({ code: 'code-1', codeVerifier: 'v-1', nonce: 'n-1' })).resolves.toEqual({
      sub: 'google-sub-1',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada',
      authTime: null,
    });
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(calls[0]?.body ?? [])).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', code_verifier: 'v-1', redirect_uri: config.redirectUri });
  });

  it.each([
    ['a wrong nonce', { nonce: 'other' }, {}],
    ['a wrong audience', {}, { aud: 'someone-else' }],
    ['a wrong issuer', {}, { iss: 'https://evil.example' }],
    ['a non-boolean email_verified', { email_verified: 'true' }, {}],
  ])('rejects an id_token with %s', async (_label, claims, opts) => {
    const { client } = clientReturning({ id_token: await idToken(claims, opts) });

    await expect(client.exchange({ code: 'c', codeVerifier: 'v', nonce: 'n-1' })).rejects.toThrow();
  });

  it('asks for a fresh Google sign-in on reauth (prompt=login, max_age=0)', () => {
    const client = new GoogleOAuthHttpClient(config, fetch, jwks);
    const reauth = new URL(client.authorizationUrl({ state: 's', codeChallenge: 'cc', nonce: 'n', reauth: true })).searchParams;
    const normal = new URL(client.authorizationUrl({ state: 's', codeChallenge: 'cc', nonce: 'n', reauth: false })).searchParams;

    expect([reauth.get('prompt'), reauth.get('max_age')]).toEqual(['login', '0']);
    expect([normal.get('prompt'), normal.get('max_age')]).toEqual(['select_account', null]);
  });

  it('returns auth_time from the id_token when present, and rejects a non-integer one', async () => {
    const withTime = clientReturning({ id_token: await idToken({ auth_time: 1_792_670_000 }) });
    await expect(withTime.client.exchange({ code: 'c', codeVerifier: 'v', nonce: 'n-1' })).resolves.toMatchObject({ authTime: 1_792_670_000 });
    const without = clientReturning({ id_token: await idToken({}) });
    await expect(without.client.exchange({ code: 'c', codeVerifier: 'v', nonce: 'n-1' })).resolves.toMatchObject({ authTime: null });
    const bad = clientReturning({ id_token: await idToken({ auth_time: 'yesterday' }) });
    await expect(bad.client.exchange({ code: 'c', codeVerifier: 'v', nonce: 'n-1' })).rejects.toBeInstanceOf(GoogleExchangeError);
  });

  it('rejects an id_token signed by an unknown key', async () => {
    const stranger = await generateKeyPair('RS256');
    const forged = await new SignJWT({ email: 'ada@example.com', email_verified: true, nonce: 'n-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('x')
      .setIssuer('https://accounts.google.com')
      .setAudience(config.clientId)
      .setExpirationTime('5m')
      .sign(stranger.privateKey);
    const { client } = clientReturning({ id_token: forged });

    await expect(client.exchange({ code: 'c', codeVerifier: 'v', nonce: 'n-1' })).rejects.toThrow();
  });

  it('fails with a status-only error when the token endpoint refuses, without echoing the body', async () => {
    const { client } = clientReturning({ error: 'invalid_grant', error_description: 'code shh-secret' }, 400);

    const error = await client.exchange({ code: 'c', codeVerifier: 'v', nonce: 'n' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleExchangeError);
    expect((error as Error).message).toBe('Token endpoint returned 400');
  });
});

describe('JoseOAuthStateStore', () => {
  const store = new JoseOAuthStateStore('a'.repeat(64), 'https://api.example');
  const state = {
    state: 's'.repeat(43),
    codeVerifier: 'v'.repeat(64),
    nonce: 'n'.repeat(43),
    origin: 'https://eduujoy.aindrajaya.my.id',
    returnTo: '/paths',
    reauth: false,
  };

  it('round-trips the state', async () => {
    await expect(store.open(await store.seal(state))).resolves.toEqual(state);
  });

  it('rejects state sealed with another key or tampered', async () => {
    const other = new JoseOAuthStateStore('b'.repeat(64), 'https://api.example');
    const sealed = await store.seal(state);

    await expect(store.open(await other.seal(state))).resolves.toBeNull();
    // Change one character in the middle of the signed payload, always to a different one. (Overwriting the
    // signature's last two characters was flaky: its final base64url character carries only 4 data bits,
    // so some runs left the bytes unchanged and the "tampered" state was genuine.)
    const parts = sealed.split('.');
    expect(parts).toHaveLength(3);
    const payload = parts[1] ?? '';
    const at = Math.floor(payload.length / 2);
    parts[1] = `${payload.slice(0, at)}${payload[at] === 'A' ? 'B' : 'A'}${payload.slice(at + 1)}`;
    await expect(store.open(parts.join('.'))).resolves.toBeNull();
    // A different signature is rejected too.
    const signature = parts[2] ?? '';
    await expect(store.open(`${parts[0] ?? ''}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`)).resolves.toBeNull();
  });

  it('rejects a reauth flag forged into a signed state, and reads old states as normal sign-ins', async () => {
    const sealed = await store.seal(state);
    const [header, payload, signature] = sealed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as object), reauth: true })).toString('base64url');

    await expect(store.open(`${header}.${forged}.${signature}`)).resolves.toBeNull();
    // A state sealed before 0.8.0 has no reauth field (the store signs whatever it is given).
    const before080 = Object.fromEntries(Object.entries(state).filter(([k]) => k !== 'reauth')) as unknown as typeof state;
    await expect(store.open(await store.seal(before080))).resolves.toEqual({ ...state, reauth: false });
  });

  it.each(['//evil.example', '/a\\b', 'https://evil.example', '/today\n'])(
    'rejects an unsafe returnTo %j even if correctly signed',
    async (returnTo) => {
      await expect(store.open(await store.seal({ ...state, returnTo }))).resolves.toBeNull();
    },
  );
});
