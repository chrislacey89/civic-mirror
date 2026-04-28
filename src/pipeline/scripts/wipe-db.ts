import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: [".env.local", ".env"] });

const url = process.env.DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error("DATABASE_URL not set");

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
