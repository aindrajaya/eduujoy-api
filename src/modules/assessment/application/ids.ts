const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Non-UUID ids are treated as not found instead of reaching Postgres. */
export const isUuid = (id: string): boolean => UUID.test(id);
