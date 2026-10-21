import { ProblemException } from '../problem';
import { readIdempotencyKey } from './idempotency-key';

describe('readIdempotencyKey', () => {
  it('returns undefined when the optional header is absent', () => {
    expect(readIdempotencyKey(undefined, false)).toBeUndefined();
  });

  it('accepts 8 to 128 characters', () => {
    expect(readIdempotencyKey('k'.repeat(8), false)).toBe('kkkkkkkk');
    expect(readIdempotencyKey('k'.repeat(128), true)).toHaveLength(128);
  });

  it('rejects a short, long, repeated or missing required key with a 400 naming the header', () => {
    for (const [value, required] of [['short', false], ['k'.repeat(129), false], [['aaaaaaaa', 'bbbbbbbb'], false], [undefined, true]] as const) {
      let error: unknown;
      try {
        readIdempotencyKey(value as string | string[] | undefined, required);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ProblemException);
      expect((error as ProblemException).getStatus()).toBe(400);
      expect((error as ProblemException).problem.errors?.[0]?.field).toBe('Idempotency-Key');
    }
  });
});
