// Deterministic env for e2e runs; a local .env is never loaded into the app. DATABASE_URL and
// DATABASE_SCHEMA come from test/db/global-setup.ts (the run's schema on the Neon test branch).
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_ORIGIN: 'http://localhost:5173,https://eduujoy.aindrajaya.my.id',
  API_PUBLIC_URL: 'http://localhost:3000',
  APP_VERSION: 'e2e',
  // Test-only values; e2e never talks to Google (the OAuth client is replaced with a fake).
  JWT_ACCESS_SECRET: 'e2e-access-secret-'.padEnd(64, 'x'),
  REFRESH_TOKEN_PEPPER: 'e2e-refresh-pepper-'.padEnd(64, 'y'),
  GOOGLE_OAUTH_CLIENT_ID: 'e2e-client.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'e2e-google-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/v1/auth/google/callback',
  // Fake AI keys: e2e never reaches a provider (AI calls are covered by offline contract tests).
  ANTHROPIC_API_KEY: 'e2e-anthropic-key',
  GEMINI_API_KEY: 'e2e-gemini-key',
  AI_DAILY_BUDGET_USD: '5',
  // Test-only billing values; e2e signs its own webhooks and never reaches Lemon Squeezy (fake provider).
  LEMONSQUEEZY_API_KEY: 'e2e-lemonsqueezy-key',
  LEMONSQUEEZY_STORE_ID: '100001',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'e2e-webhook-secret-'.padEnd(40, 'z'),
  LEMONSQUEEZY_VARIANT_SUBSCRIPTION: '200001',
  LEMONSQUEEZY_VARIANT_CREDIT_PACK: '200002',
  LEMONSQUEEZY_MODE: 'test',
  // Fake discovery keys: the YouTube and OpenAlex adapters are faked in e2e (test/app.ts).
  YOUTUBE_API_KEY: 'e2e-youtube-key',
  OPENALEX_API_KEY: 'e2e-openalex-key',
});
