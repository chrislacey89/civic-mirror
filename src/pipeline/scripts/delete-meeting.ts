/**
 * Removes one meeting and every row that hangs off it.
 *
 *   pnpm tsx src/pipeline/scripts/delete-meeting.ts <body-slug> <YYYY-MM-DD>
 *   pnpm tsx src/pipeline/scripts/delete-meeting.ts <body-slug> <YYYY-MM-DD> --confirm
 *
 * Without --confirm it only reports what it would delete. With --confirm it
 * deletes in one transaction, children first. Reads DATABASE_URL only, like
 * the other scripts in this directory.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: [".env.local", ".env"] });

const [bodySlug, date, ...flags] = process.argv.slice(2);
const confirm = flags.includes("--confirm");

if (!bodySlug || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
	console.error(
		"usage: delete-meeting.ts <body-slug> <YYYY-MM-DD> [--confirm]",
	);
	process.exit(2);
}

const url = process.env.DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error("DATABASE_URL not set");

const client = createClient({ url, ...(authToken ? { authToken } : {}) });

const found = await client.execute({
	sql: `SELECT m.id FROM meetings m
		JOIN governing_bodies gb ON gb.id = m.body_id
		WHERE gb.slug = ? AND m.date = ?`,
	args: [bodySlug, date],
});

if (found.rows.length === 0) {
	console.log(`no meeting for ${bodySlug} on ${date}; nothing to delete.`);
	process.exit(0);
}

const meetingId = Number(found.rows[0].id);
console.log(`target: ${url.replace(/\?.*$/, "")}`);
console.log(`meeting id=${meetingId} body=${bodySlug} date=${date}`);

// Children first: every table here holds a foreign key to the one after it
// or to meetings, and SQLite refuses the parent delete while they exist.
const childTables = [
	{
		table: "drama_category_scores",
		where:
			"assessment_id IN (SELECT id FROM drama_assessments WHERE meeting_id = ?)",
	},
	{ table: "drama_assessments", where: "meeting_id = ?" },
	{ table: "budget_discussions", where: "meeting_id = ?" },
	{ table: "fiscal_decisions", where: "meeting_id = ?" },
	{ table: "summaries", where: "meeting_id = ?" },
	{ table: "transcripts", where: "meeting_id = ?" },
	{ table: "documents", where: "meeting_id = ?" },
];

for (const { table, where } of childTables) {
	const count = await client.execute({
		sql: `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`,
		args: [meetingId],
	});
	console.log(`  ${table}: ${count.rows[0].c}`);
}

const docs = await client.execute({
	sql: "SELECT source_url FROM documents WHERE meeting_id = ? ORDER BY id",
	args: [meetingId],
});
for (const row of docs.rows) console.log(`    document ${row.source_url}`);

if (!confirm) {
	console.log("dry run. re-run with --confirm to delete these rows.");
	process.exit(0);
}

await client.batch(
	[
		...childTables.map(({ table, where }) => ({
			sql: `DELETE FROM ${table} WHERE ${where}`,
			args: [meetingId],
		})),
		{ sql: "DELETE FROM meetings WHERE id = ?", args: [meetingId] },
	],
	"write",
);

console.log(`deleted meeting id=${meetingId} and its child rows.`);
