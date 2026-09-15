import type { Config } from "drizzle-kit";
import { describe, expect, it } from "vitest";
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

describe("resolveDatabaseUrl", () => {
	it("agrees with drizzle.config.ts's resolved database URL", async () => {
		// drizzle.config.ts is loaded by drizzle-kit outside the app's module
		// graph, so it can't just import the app's `db` client — it resolves
		// the URL independently via the same shared helper. This test imports
		// the *actual* config module (not a copy of its logic) and asserts its
		// resolved `dbCredentials.url` equals what the app itself resolves, so
		// a future edit that reintroduces a second, divergent resolution path
		// in either file fails the suite instead of silently drifting.
		const drizzleConfig = (await import("../../drizzle.config.ts"))
			.default as TursoConfig;

		expect(drizzleConfig.dbCredentials?.url).toBe(resolveDatabaseUrl());
	});
});
