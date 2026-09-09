import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { requireDatabaseUrl } from "#/db/url.ts";

config({ path: [".env.local", ".env"] });

const url = requireDatabaseUrl();
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({ url, ...(authToken ? { authToken } : {}) });

const tables = [
	"budget_discussions",
	"fiscal_decisions",
	"summaries",
	"transcripts",
	"documents",
	"meetings",
	"governing_bodies",
	"__drizzle_migrations",
];

for (const t of tables) {
	await client.execute(`DROP TABLE IF EXISTS ${t}`);
	console.log(`dropped ${t}`);
}

console.log("done. run pnpm db:migrate next.");
