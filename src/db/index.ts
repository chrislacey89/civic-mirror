import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema.ts";

// DATABASE_URL is the canonical name across web, seed, drizzle-kit and the
// pipeline. TURSO_DATABASE_URL is accepted as a legacy alias so an existing
// deployment keeps working while it is migrated.
const databaseUrl = process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL;

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
