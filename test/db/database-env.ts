export interface DatabaseEnv {
  test: string | undefined;
  app: string | undefined;
  direct: string | undefined;
}

/**
 * The database URLs, from the process env only. Never reads .env: the package scripts inject it with
 * `node --env-file-if-exists=.env` locally, and CI provides DATABASE_URL_TEST as a secret.
 */
export function readDatabaseEnv(): DatabaseEnv {
  return {
    test: process.env['DATABASE_URL_TEST'],
    app: process.env['DATABASE_URL'],
    direct: process.env['DATABASE_URL_DIRECT'],
  };
}
