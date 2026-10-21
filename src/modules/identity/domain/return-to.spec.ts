import { DEFAULT_RETURN_TO, safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it.each(['/', '/today', '/paths/123?tab=steps#s2', '/a/b%2F%2Fc', '/search?q=a b'])('keeps the same-site path %j', (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', ['/a', '/b']],
    ['a number', 42],
    ['relative without a leading slash', 'paths'],
    ['protocol-relative', '//evil.example'],
    ['protocol-relative with a path', '//evil.example/today'],
    ['a backslash after the slash', '/\\evil.example'],
    ['a backslash later in the path', '/a\\b'],
    ['an absolute http URL', 'http://evil.example'],
    ['an absolute https URL', 'https://evil.example/today'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>'],
    ['a tab that URL parsers strip', '/\t/evil.example'],
    ['a newline', '/today\nSet-Cookie: x=y'],
    ['a carriage return', '/today\r'],
    ['a NUL byte', '/today\u0000'],
    ['DEL', '/today\u007f'],
    ['a Unicode line separator', '/today\u2028'],
    ['an over-long path', `/${'a'.repeat(600)}`],
  ])('falls back to /today for %s', (_label, value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_RETURN_TO);
  });

  it('defaults to /today', () => {
    expect(DEFAULT_RETURN_TO).toBe('/today');
  });
});
