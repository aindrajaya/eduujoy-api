const SECRET_KEYS = new Set(['passwordHash', 'password_hash', 'password', 'googleSub', 'google_sub', 'refreshHash', 'refresh_hash']);

/** Every key path in a response body whose name is a credential or identity secret. */
export function secretKeyPaths(value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => secretKeyPaths(item, `${at}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(SECRET_KEYS.has(key) ? [`${at}.${key}`] : []),
    ...secretKeyPaths(child, `${at}.${key}`),
  ]);
}
