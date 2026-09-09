/**
 * Single source of truth for "where is the database" — every module that
 * opens a database connection (the app, the seeder, drizzle-kit, the
 * pipeline's ops scripts) resolves the URL through here instead of
 * re-deriving its own env-var precedence and its own idea of what "unset"
 * means. Before this file existed, seven call sites disagreed on both: some
 * read TURSO_DATABASE_URL, some read DATABASE_URL, and some treated ""
 * (which dotenv produces for a blank .env.example line) as a real value
 * while others treated it as unset — which is exactly the split that
 * produced `Failed query: select ... from "governing_bodies"` against a
 * database nobody meant to open.
 *
 * This file has no dependency on @libsql/client or drizzle so it stays
 * resolvable from drizzle.config.ts, which drizzle-kit loads outside the
 * app's module graph via its own bundler.
 */

function readUrlEnv(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

/** DATABASE_URL wins if both are set; "" counts as unset either way. */
function readConfiguredUrl(): string | undefined {
	return readUrlEnv("DATABASE_URL") ?? readUrlEnv("TURSO_DATABASE_URL");
}

/**
 * Resolve the database URL for app/dev-convenience contexts (the web app,
 * the seeder, drizzle-kit): use the configured URL if present, otherwise
 * fall back to the local sqlite file so a fresh checkout with zero env vars
 * still works — except in production, where a missing URL almost certainly
 * means a renamed/unset env var, and silently opening a throwaway file
 * would hide that misconfiguration behind a green run.
 */
export function resolveDatabaseUrl(): string {
	const configured = readConfiguredUrl();
	if (configured) return configured;

	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"DATABASE_URL/TURSO_DATABASE_URL is not set in a production environment. " +
				"Refusing to fall back to file:dev.db — set DATABASE_URL or TURSO_DATABASE_URL.",
		);
	}

	return "file:dev.db";
}

/**
 * Resolve the database URL for contexts that must never guess: standalone
 * pipeline/ops scripts that operate on a specific database (the pipeline
 * composition root, wipe/verify scripts). Always throws when unset,
 * regardless of NODE_ENV — these scripts have no "local dev default"
 * because running them against the wrong (or an implicit) database is the
 * failure mode they exist to prevent.
 */
export function requireDatabaseUrl(): string {
	const configured = readConfiguredUrl();
	if (!configured) {
		throw new Error(
			"DATABASE_URL/TURSO_DATABASE_URL is not set. Set it in .env.local or the shell.",
		);
	}
	return configured;
}
