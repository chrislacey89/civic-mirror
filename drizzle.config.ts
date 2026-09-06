import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

config({ path: ['.env.local', '.env'] })

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'turso',
  dbCredentials: {
    // Fall back to the same local file the app defaults to in src/db/index.ts,
    // so `pnpm db:setup` works in a fresh checkout with no env at all.
    url: process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? "file:dev.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
})
