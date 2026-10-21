import { describeError, redactConnectionStrings } from './redact';

describe('redactConnectionStrings', () => {
  it('masks every postgres URL, keeping only the scheme', () => {
    const text = 'connect to postgresql://user:p%40ss@ep-x.neon.tech/db?sslmode=require failed; also postgres://a:b@h/d';

    expect(redactConnectionStrings(text)).toBe('connect to postgresql://[redacted] failed; also postgres://[redacted]');
  });
});

describe('describeError', () => {
  it('uses the message of an Error and redacts it', () => {
    expect(describeError(new Error('bad postgres://u:secret@h/d'))).toBe('Error: bad postgres://[redacted]');
  });

  it('handles non-Error values', () => {
    expect(describeError('boom')).toBe('boom');
  });
});
