import { readFileSync } from "node:fs";
import type { Client } from "@libsql/client";

type JournalEntry = { tag: string; when: number };

/**
 * The journal entries `drizzle-kit migrate` would still apply: every one
 * newer than the newest migration recorded as applied. This is drizzle's own
 * rule, so an older entry missing from the history is not reported.
 */
export function pendingMigrations(
	journal: readonly JournalEntry[],
	appliedCreatedAt: readonly number[],
): string[] {
	const newestApplied = Math.max(0, ...appliedCreatedAt);
	return journal
		.filter((entry) => entry.when > newestApplied)
		.map((entry) => entry.tag);
}

export function readJournal(
	path = "drizzle/meta/_journal.json",
): JournalEntry[] {
	const { entries } = JSON.parse(readFileSync(path, "utf8")) as {
		entries: JournalEntry[];
	};
	return entries.map(({ tag, when }) => ({ tag, when }));
}

/** The `created_at` of every applied migration; empty when none has run. */
export async function readAppliedMigrations(client: Client): Promise<number[]> {
	const table = await client.execute(
		"select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
	);
	if (table.rows.length === 0) return [];
	const applied = await client.execute(
		"select created_at from __drizzle_migrations",
	);
	return applied.rows.map((row) => Number(row.created_at));
}
