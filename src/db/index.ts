import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { resolveDatabaseUrl } from "./database-url.ts";
import * as schema from "./schema.ts";

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl && process.env.NODE_ENV === "production") {
	throw new Error(
		"DATABASE_URL (or TURSO_DATABASE_URL) must be set in production; refusing to fall back to file:dev.db",
	);
}

const client = createClient({
	url: databaseUrl ?? "file:dev.db",
	authToken: process.env.TURSO_AUTH_TOKEN,
});

export const db = drizzle(client, { schema });
