import { defineConfig } from 'drizzle-kit';

// Generation only (`pnpm db:generate`); migrations are applied by src/shared/db/migrate.ts,
// which can target a per-run test schema.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/db/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
});
