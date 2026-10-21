// Runs before `vite build`. Production migrations are applied by hand with
// `pnpm db:migrate`, and code that reads a column production lacks returns
// 500 on every page that touches it. A production build with pending
// migrations fails here instead, so Vercel keeps serving the previous
// deployment until the migration is applied.
//
// Only a production build fails. Other builds print the pending list and
// continue, and a build with no database URL skips the check.
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

import { createClient } from "@libsql/client";
import { resolveDatabaseUrl } from "#/db/database-url.ts";
import {
	pendingMigrations,
	readAppliedMigrations,
	readJournal,
} from "#/db/migration-status.ts";

const url = resolveDatabaseUrl();
const isProductionBuild = process.env.VERCEL_ENV === "production";

if (!url) {
	console.warn(
		`[check-migrations] skipped: no DATABASE_URL${isProductionBuild ? " (production build: the check did not run)" : ""}`,
	);
	process.exit(0);
}

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const pending = pendingMigrations(
	readJournal(),
	await readAppliedMigrations(client),
);
client.close();

if (pending.length === 0) {
	console.log("[check-migrations] up to date");
	process.exit(0);
}

console.error(
	`[check-migrations] ${pending.length} migration(s) not applied to the database: ${pending.join(", ")}`,
);
if (isProductionBuild) {
	console.error(
		"[check-migrations] failing the production build. Run `pnpm db:migrate` against production, then redeploy.",
	);
	process.exit(1);
}
