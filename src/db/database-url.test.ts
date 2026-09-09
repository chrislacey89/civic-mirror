import { afterEach, describe, expect, it } from "vitest";

import { resolveDatabaseUrl } from "#/db/database-url.ts";

const TOUCHED = ["DATABASE_URL", "TURSO_DATABASE_URL"] as const;

afterEach(() => {
	for (const name of TOUCHED) delete process.env[name];
});

// Regression coverage for issue #78: the weekly ingest workflow set
// TURSO_DATABASE_URL (the only name the workflow knew), while composition.ts,
// db/index.ts, and db/seed.ts all resolve through this function. Pinning the
// actual priority/empty-string rule here means a regression in any one of
// those three call sites shows up as a failure in the shared source of
// truth, not just in a test against invented variable names.
describe("resolveDatabaseUrl", () => {
	it("returns DATABASE_URL when only it is set", () => {
		process.env.DATABASE_URL = "libsql://primary.example";

		expect(resolveDatabaseUrl()).toBe("libsql://primary.example");
	});

	it("prefers DATABASE_URL over TURSO_DATABASE_URL when both are set", () => {
		process.env.DATABASE_URL = "libsql://primary.example";
		process.env.TURSO_DATABASE_URL = "libsql://legacy.example";

		expect(resolveDatabaseUrl()).toBe("libsql://primary.example");
	});

	it("falls back to TURSO_DATABASE_URL when DATABASE_URL is unset", () => {
		process.env.TURSO_DATABASE_URL = "libsql://legacy.example";

		expect(resolveDatabaseUrl()).toBe("libsql://legacy.example");
	});

	it("treats an empty DATABASE_URL as unset and falls back to the alias", () => {
		process.env.DATABASE_URL = "";
		process.env.TURSO_DATABASE_URL = "libsql://legacy.example";

		expect(resolveDatabaseUrl()).toBe("libsql://legacy.example");
	});

	it("treats an empty TURSO_DATABASE_URL as unset", () => {
		process.env.DATABASE_URL = "";
		process.env.TURSO_DATABASE_URL = "";

		expect(resolveDatabaseUrl()).toBeUndefined();
	});

	it("returns undefined when neither variable is set", () => {
		expect(resolveDatabaseUrl()).toBeUndefined();
	});
});
