import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { onTestFinished } from "vitest";
import * as schema from "#/db/schema.ts";

let dbCounter = 0;

/**
 * A fully migrated database in a temp file, removed when the calling test
 * finishes. Call it from inside a test.
 */
export async function createMigratedTestDb() {
	const file = path.join(
		os.tmpdir(),
		`civic-mirror-pipeline-test-${process.pid}-${dbCounter++}.db`,
	);
	onTestFinished(() => {
		fs.rmSync(file, { force: true });
	});
	const db = drizzle(createClient({ url: `file:${file}` }), { schema });
	await migrate(db, { migrationsFolder: "./drizzle" });
	return db;
}
