import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: [".env.local", ".env"] });

const client = createClient({
	url: process.env.DATABASE_URL ?? "",
	...(process.env.TURSO_AUTH_TOKEN
		? { authToken: process.env.TURSO_AUTH_TOKEN }
		: {}),
});

const meetings = await client.execute(`
	SELECT m.id, m.date, gb.slug
	FROM meetings m
	JOIN governing_bodies gb ON gb.id = m.body_id
	WHERE gb.slug = 'ellettsville-town-council'
	ORDER BY m.date DESC
`);

console.log(`meetings for ellettsville-town-council: ${meetings.rows.length}`);
for (const r of meetings.rows) {
	console.log(`  id=${r.id} date=${r.date}`);
}

const dupes = await client.execute(`
	SELECT body_id, date, COUNT(*) c
	FROM meetings
	GROUP BY body_id, date
	HAVING COUNT(*) > 1
`);
console.log(`duplicates: ${dupes.rows.length}`);

const docs = await client.execute(`
	SELECT meeting_id, COUNT(*) c
	FROM documents
	GROUP BY meeting_id
	ORDER BY c DESC
	LIMIT 5
`);
console.log(`documents per meeting (top 5):`);
for (const r of docs.rows) {
	console.log(`  meeting_id=${r.meeting_id} docs=${r.c}`);
}
