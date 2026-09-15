import type { Config } from "drizzle-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./url.ts";

// drizzle-kit's `Config` is a six-dialect union (postgresql/mysql/sqlite/
// turso/singlestore/gel) and only the turso branch carries `dbCredentials`.
// `drizzle.config.ts` always sets `dialect: "turso"`, but `defineConfig`'s
// declared return type is the full widened `Config`, so the import below
// loses that narrowing. This local type — not `any`, not a blanket cast —
// pins the *same* assumption the test already depends on (that this repo's
// drizzle config is a turso config) so `dbCredentials.url` type-checks
// without weakening what the assertion below verifies at runtime.
type TursoConfig = Extract<Config, { dialect: "turso" }>;

const ENV_VARS = ["DATABASE_URL", "TURSO_DATABASE_URL", "NODE_ENV"] as const;
type EnvVar = (typeof ENV_VARS)[number];
let saved: Partial<Record<EnvVar, string>>;

beforeEach(() => {
	saved = {};
	for (const key of ENV_VARS) {
		const value = process.env[key];
		if (value !== undefined) saved[key] = value;
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_VARS) delete process.env[key];
	Object.assign(process.env, saved);
});

describe("resolveDatabaseUrl", () => {
	// Each case pins against a literal known in advance — not a second call to
	// resolveDatabaseUrl(), and not a recomputation of its formula — per
	// tdd/tests.md § The Oracle: a test whose expected value is computed by
	// the same logic as the code under test agrees with a regression that
	// happens to reach the same answer by a different path.

	it("falls back to file:dev.db when nothing is configured", () => {
		expect(resolveDatabaseUrl()).toBe("file:dev.db");
	});

	it("uses DATABASE_URL when only DATABASE_URL is set", () => {
		process.env.DATABASE_URL = "libsql://app-db.example.turso.io";
		expect(resolveDatabaseUrl()).toBe("libsql://app-db.example.turso.io");
	});

	it("uses TURSO_DATABASE_URL when only TURSO_DATABASE_URL is set", () => {
		process.env.TURSO_DATABASE_URL = "libsql://turso-db.example.turso.io";
		expect(resolveDatabaseUrl()).toBe("libsql://turso-db.example.turso.io");
	});

	it("prefers DATABASE_URL over TURSO_DATABASE_URL when both are set", () => {
		process.env.DATABASE_URL = "libsql://app-db.example.turso.io";
		process.env.TURSO_DATABASE_URL = "libsql://turso-db.example.turso.io";
		expect(resolveDatabaseUrl()).toBe("libsql://app-db.example.turso.io");
	});

	it("treats an empty DATABASE_URL as unset and falls back to TURSO_DATABASE_URL", () => {
		process.env.DATABASE_URL = "";
		process.env.TURSO_DATABASE_URL = "libsql://turso-db.example.turso.io";
		expect(resolveDatabaseUrl()).toBe("libsql://turso-db.example.turso.io");
	});

	it("throws in production when nothing is configured, instead of silently opening file:dev.db", () => {
		process.env.NODE_ENV = "production";
		expect(() => resolveDatabaseUrl()).toThrow(
			/DATABASE_URL\/TURSO_DATABASE_URL is not set in a production environment/,
		);
	});
});

describe("drizzle.config.ts", () => {
	it("resolves dbCredentials.url from TURSO_DATABASE_URL, the one input that exposes a config that stopped delegating to resolveDatabaseUrl", async () => {
		// drizzle.config.ts is loaded by drizzle-kit outside the app's module
		// graph, so it can't just import the app's `db` client — it must
		// resolve the URL independently via the shared helper. This imports
		// the *actual* config module (not a copy of its logic) and checks its
		// resolved dbCredentials.url against a literal known in advance.
		//
		// DATABASE_URL is deliberately left unset and TURSO_DATABASE_URL is
		// the only configured var: a drizzle.config.ts that regresses to the
		// divergent literal `process.env.DATABASE_URL ?? "file:dev.db"`
		// (dropping TURSO_DATABASE_URL support and the production guard)
		// produces the *same* url as the correct code whenever DATABASE_URL is
		// set or nothing is set at all — those two inputs can't distinguish
		// the regression from the fix. This is the only input that can, so
		// the case sets it explicitly rather than relying on whatever the
		// ambient test environment happens to export (nothing in this repo
		// sets TURSO_DATABASE_URL for `pnpm test` otherwise).
		process.env.TURSO_DATABASE_URL = "libsql://turso-db.example.turso.io";

		const drizzleConfig = (await import("../../drizzle.config.ts"))
			.default as TursoConfig;

		expect(drizzleConfig.dbCredentials?.url).toBe(
			"libsql://turso-db.example.turso.io",
		);
	});
});
