import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import { resolveDatabaseUrl } from './src/db/url.ts'

config({ path: ['.env.local', '.env'] })

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'turso',
  dbCredentials: {
    url: resolveDatabaseUrl(),
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
})
