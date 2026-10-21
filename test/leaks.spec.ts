import { secretKeyPaths } from './leaks';

describe('secretKeyPaths', () => {
  it('finds secret keys at any depth, including inside arrays', () => {
    expect(secretKeyPaths({ user: { id: 1, passwordHash: 'x' }, items: [{ google_sub: null }] })).toEqual([
      '$.user.passwordHash',
      '$.items[0].google_sub',
    ]);
  });

  it('returns nothing for a clean body', () => {
    expect(secretKeyPaths({ user: { id: 1, email: 'a@b.c' }, roles: ['learner'] })).toEqual([]);
  });
});
