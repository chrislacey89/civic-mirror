import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./url.ts";

describe("resolveDatabaseUrl", () => {
	it("agrees with drizzle.config.ts's resolved database URL", async () => {
		// drizzle.config.ts is loaded by drizzle-kit outside the app's module
		// graph, so it can't just import the app's `db` client — it resolves
		// the URL independently via the same shared helper. This test imports
		// the *actual* config module (not a copy of its logic) and asserts its
		// resolved `dbCredentials.url` equals what the app itself resolves, so
		// a future edit that reintroduces a second, divergent resolution path
		// in either file fails the suite instead of silently drifting.
		const drizzleConfig = (await import("../../drizzle.config.ts")).default;

		expect(drizzleConfig.dbCredentials?.url).toBe(resolveDatabaseUrl());
	});
});
