// Deterministic env for e2e runs; a local .env is never loaded into the app. DATABASE_URL and
// DATABASE_SCHEMA come from test/db/global-setup.ts (the run's schema on the Neon test branch).
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_ORIGIN: 'http://localhost:5173,https://eduujoy.aindrajaya.my.id',
  API_PUBLIC_URL: 'http://localhost:3000',
  APP_VERSION: 'e2e',
});
