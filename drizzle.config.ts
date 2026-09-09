import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

config({ path: ['.env.local', '.env'] })

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL
  if (url) return url

  // Fall back to the same local file the app defaults to in src/db/index.ts,
  // so `pnpm db:setup` works in a fresh checkout with no env at all — but
  // only outside production, where a missing URL almost certainly means a
  // renamed/unset env var rather than an intentional local run. Falling
  // back there would migrate a throwaway sqlite file instead of refusing
  // to run, hiding the misconfiguration behind a green migration step.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL/TURSO_DATABASE_URL is not set in a production environment. " +
        "Refusing to fall back to file:dev.db — set DATABASE_URL or TURSO_DATABASE_URL.",
    )
  }

  return "file:dev.db"
}

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'turso',
  dbCredentials: {
    url: resolveDatabaseUrl(),
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
})
