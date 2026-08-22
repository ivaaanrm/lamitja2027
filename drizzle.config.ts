import { defineConfig } from 'drizzle-kit'

// Generates SQL into `migrations/`, which wrangler's default `migrations/*.sql`
// pattern picks up. Apply with `pnpm db:migrate:local` / `pnpm db:migrate`.
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/lib/db/schema.ts',
  out: './migrations',
  casing: 'snake_case',
})
