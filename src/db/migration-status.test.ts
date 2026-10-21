import { describe, expect, it } from "vitest";

import { pendingMigrations } from "#/db/migration-status.ts";

const journal = [
	{ tag: "0007_summaries_sources", when: 1791318389447 },
	{ tag: "0008_held_videos", when: 1791335364509 },
	{ tag: "0009_summary_holds", when: 1792290379904 },
];

// drizzle-kit's libsql migrator applies every journal entry whose `when` is
// later than the newest `created_at` in `__drizzle_migrations`. These pin the
// same rule, so the build refuses exactly the deploys `db:migrate` would
// still have work for.
describe("pendingMigrations", () => {
	it("is empty when the newest applied migration is the newest in the journal", () => {
		expect(
			pendingMigrations(journal, [1791318389447, 1791335364509, 1792290379904]),
		).toEqual([]);
	});

	it("lists the journal entries newer than the newest applied one", () => {
		expect(pendingMigrations(journal, [1791318389447, 1791335364509])).toEqual([
			"0009_summary_holds",
		]);
	});

	it("lists every entry when the history table is empty or missing", () => {
		expect(pendingMigrations(journal, [])).toEqual([
			"0007_summaries_sources",
			"0008_held_videos",
			"0009_summary_holds",
		]);
	});

	it("does not report an older entry missing from the history, as drizzle would not apply it either", () => {
		expect(pendingMigrations(journal, [1792290379904])).toEqual([]);
	});
});
