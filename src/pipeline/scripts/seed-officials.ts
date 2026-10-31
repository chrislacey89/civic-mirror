import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import * as schema from "#/db/schema.ts";
import { extractNames } from "#/pipeline/checks/names.ts";
import {
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";

/**
 * Prints candidate entries for an officials list from a body's stored
 * minutes, for a person to review and copy by hand into
 * src/pipeline/officials/. Nothing here writes a config file, and no model is
 * called. A resident who speaks often can appear, so every line is read
 * before it is kept.
 *
 * Usage: tsx src/pipeline/scripts/seed-officials.ts <body-slug> [min-meetings]
 */

type MinutesOfMeeting = { date: string; text: string };

type OfficialCandidate = {
	name: string;
	meetings: number;
	/** ISO dates of the first and last meetings that print the name. */
	first: string;
	last: string;
	/** The capitalised words printed beside the name. */
	roles: readonly string[];
};

const ROLE = String.raw`[A-Z][a-z-]+(?: [A-Z][a-z-]+){0,3}`;

/** The roles `text` prints beside `name`: "Town Manager X", "X, Town Manager". */
function rolesBeside(name: string, text: string): string[] {
	const before = new RegExp(String.raw`(${ROLE}) ${name}`, "g");
	const after = new RegExp(String.raw`${name}, (${ROLE})`, "g");
	return [...text.matchAll(before), ...text.matchAll(after)].flatMap((match) =>
		match[1] === undefined ? [] : [match[1]],
	);
}

/** Each full name in at least `minMeetings` meetings, most meetings first. */
function officialCandidates(
	minutes: readonly MinutesOfMeeting[],
	minMeetings: number,
): OfficialCandidate[] {
	const ordered = [...minutes].sort((a, b) => a.date.localeCompare(b.date));
	const seen = new Map<string, string[]>();
	for (const { date, text } of ordered) {
		for (const name of extractNames(text)) {
			if (name.includes(" ")) seen.set(name, [...(seen.get(name) ?? []), date]);
		}
	}
	return [...seen]
		.filter(([, dates]) => dates.length >= minMeetings)
		.map(([name, dates]) => ({
			name,
			meetings: dates.length,
			first: dates[0] ?? "",
			last: dates.at(-1) ?? "",
			roles: [
				...new Set(ordered.flatMap(({ text }) => rolesBeside(name, text))),
			],
		}))
		.sort((a, b) => b.meetings - a.meetings);
}

function minutesOfBody(
	bodySlug: string,
): Effect.Effect<MinutesOfMeeting[], unknown, StorageService> {
	return Effect.gen(function* () {
		const storage = yield* StorageService;
		const meetings = yield* storage.listSummaryMeetings({
			bodySlug,
			scope: "all",
		});
		const minutes: MinutesOfMeeting[] = [];
		for (const meeting of meetings) {
			const sources = yield* storage.getMeetingSources(meeting.meetingId);
			const text = sources.documents.map((d) => d.rawText).join("\n");
			if (text.trim() !== "") minutes.push({ date: meeting.date, text });
		}
		return minutes;
	});
}

async function main(): Promise<void> {
	const [bodySlug, minMeetings = "3"] = process.argv.slice(2);
	if (bodySlug === undefined) {
		console.error("Usage: seed-officials.ts <body-slug> [min-meetings]");
		process.exit(1);
	}
	config({ path: [".env.local", ".env"] });
	const client = createClient({
		url: process.env.DATABASE_URL ?? "",
		...(process.env.TURSO_AUTH_TOKEN
			? { authToken: process.env.TURSO_AUTH_TOKEN }
			: {}),
	});
	const minutes = await Effect.runPromise(
		minutesOfBody(bodySlug).pipe(
			Effect.provide(StorageServiceLive(drizzle(client, { schema }))),
		),
	);
	console.log(`// ${bodySlug}: ${minutes.length} meetings with minutes`);
	for (const candidate of officialCandidates(minutes, Number(minMeetings))) {
		console.log(JSON.stringify(candidate));
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main();
}

export { officialCandidates };
