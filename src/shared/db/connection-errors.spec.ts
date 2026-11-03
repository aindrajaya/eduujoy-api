import { isConnectionLost } from './connection-errors';

describe('isConnectionLost', () => {
  it('recognises a lost connection, also as a wrapped cause', () => {
    expect(isConnectionLost(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).toBe(true);
    expect(isConnectionLost(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionLost(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionLost(new Error('Failed query: insert into "llm_calls" ...', { cause: Object.assign(new Error('x'), { code: '08006' }) }))).toBe(true);
  });

  it('does not treat ordinary query errors as a lost connection', () => {
    expect(isConnectionLost(Object.assign(new Error('duplicate key value'), { code: '23505' }))).toBe(false);
    expect(isConnectionLost(new Error('Gemini quota exceeded'))).toBe(false);
    expect(isConnectionLost(null)).toBe(false);
  });
});
