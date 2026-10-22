import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service';
import { DeletedUsers } from './deleted-users';

describe('DeletedUsers', () => {
  it('keeps a deleted user for the access-token lifetime, then forgets them', () => {
    let now = 1_000_000;
    const list = new DeletedUsers(undefined, () => now);

    list.add('u1');
    expect(list.has('u1')).toBe(true);
    expect(list.has('u2')).toBe(false);
    now += ACCESS_TOKEN_TTL_SECONDS * 1000 - 1;
    expect(list.has('u1')).toBe(true);
    now += 1;
    expect(list.has('u1')).toBe(false);
    expect(list.size).toBe(0);
  });

  it('prunes expired entries as new ones arrive, so it never grows past the window', () => {
    let now = 0;
    const list = new DeletedUsers(1000, () => now);
    for (let i = 0; i < 100; i++) {
      list.add(`u${i}`);
      now += 100;
    }
    // At t=10000 only the entries added after t=9000 (9100..9900) are still inside their 1 s window.
    expect(list.size).toBe(9);
  });
});
