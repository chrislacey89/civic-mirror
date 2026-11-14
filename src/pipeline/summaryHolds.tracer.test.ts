/**
 * Tracer tests for #203: each one runs the real CLI (`tsx src/pipeline/cli.ts`)
 * against a migrated temp database, and saves the transcript under
 * test-results/ as the demo script. DATABASE_URL is set for the child, and
 * dotenv never overrides a variable already set, so production is not read.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Effect } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";
import { listRecentMeetingsQuery } from "#/db/queries.ts";
import * as schema from "#/db/schema.ts";
import { PUBLISHED, publicationOf } from "#/pipeline/checks/test-outcomes.ts";
import {
	type MeetingInput,
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";

const run = promisify(execFile);
const BODY = { slug: "town-council", name: "Town Council" };
const TRUNCATED = {
	highlights: ["Council approves paving bid"],
	prose: "The council approved the paving bid for",
};

let counter = 0;

async function tracerDb() {
	const file = path.join(
		os.tmpdir(),
		`civic-mirror-tracer-${process.pid}-${counter++}.db`,
	);
	const client = createClient({ url: `file:${file}` });
	onTestFinished(() => {
		client.close();
		fs.rmSync(file, { force: true });
	});
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: "./drizzle" });
	await db
		.insert(schema.governingBodies)
		.values({ name: BODY.name, slug: BODY.slug, type: "town" })
		.run();
	const store = (input: {
		date: string;
		text: { highlights: string[]; prose: string };
		held: boolean;
	}) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				const documents: MeetingInput["documents"] = [
					{
						sourceUrl: `https://example.com/${input.date}.pdf`,
						rawText: `Minutes of ${input.date}. The council approved the paving bid.`,
						documentType: "minutes",
						extractionMethod: "text-layer",
					},
				];
				return yield* storage.storeMeeting({
					bodySlug: BODY.slug,
					date: input.date,
					meetingType: "regular",
					documents,
					summary: {
						...input.text,
						model: "m",
						publication: input.held
							? publicationOf(input.text, `run-${input.date}`)
							: PUBLISHED,
					},
					fiscalDecisions: [],
					budgetDiscussions: [],
				});
			}).pipe(Effect.provide(StorageServiceLive(db))),
		);
	return { url: `file:${file}`, db, store };
}

/** Runs one CLI command against `url`; never throws on a non-zero exit. */
async function cli(url: string, args: string[]) {
	try {
		const { stdout, stderr } = await run(
			"node_modules/.bin/tsx",
			["src/pipeline/cli.ts", ...args],
			{
				env: {
					...process.env,
					DATABASE_URL: url,
					TURSO_DATABASE_URL: url,
					TURSO_AUTH_TOKEN: "",
				},
			},
		);
		return { code: 0, stdout: withoutDotenvBanner(stdout), stderr };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: e.code ?? 1,
			stdout: withoutDotenvBanner(e.stdout ?? ""),
			stderr: e.stderr ?? "",
		};
	}
}

/** dotenv prints a "◇ injected env" line to stdout; it is not the command's output. */
function withoutDotenvBanner(stdout: string): string {
	return stdout
		.split("\n")
		.filter((line) => !line.startsWith("◇ injected env"))
		.join("\n");
}

/** A transcript a reader can follow: each command above its output. */
class Transcript {
	private lines: string[] = [];
	constructor(private readonly name: string) {}
	async run(url: string, args: string[]) {
		const result = await cli(url, args);
		this.lines.push(
			`$ pnpm pipeline ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
			result.stdout.trimEnd(),
			...(result.stderr.trim() ? [`[stderr] ${result.stderr.trimEnd()}`] : []),
			`[exit ${result.code}]`,
			"",
		);
		return result;
	}
	note(line: string) {
		this.lines.push(`# ${line}`, "");
	}
	save() {
		fs.mkdirSync("test-results", { recursive: true });
		fs.writeFileSync(
			path.join("test-results", `${this.name}.transcript.txt`),
			this.lines.join("\n"),
		);
	}
}

describe("summaries CLI (tracer)", () => {
	it("slice 1: summaries:held lists each held meeting with its failing gates and evidence", async () => {
		const { url, store } = await tracerDb();
		await store({ date: "2025-05-27", text: TRUNCATED, held: true });
		await store({
			date: "2025-06-09",
			text: { highlights: ["Paving"], prose: "The council approved the bid." },
			held: false,
		});
		const t = new Transcript("slice-1");

		const result = await t.run(url, ["summaries:held"]);
		t.save();

		expect(result.code).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("2025-05-27");
		expect(lines[0]).toContain("town-council");
		expect(lines[0]).toContain("gate-failed");
		expect(lines[0]).toContain(
			"TRUNC: The council approved the paving bid for",
		);
	}, 60_000);

	it("slice 2: summaries:release previews without --confirm, and with it publishes the held draft", async () => {
		const { url, db, store } = await tracerDb();
		await store({ date: "2025-05-27", text: TRUNCATED, held: true });
		const t = new Transcript("slice-2");
		const release = [
			"summaries:release",
			"--body",
			BODY.slug,
			"--date",
			"2025-05-27",
			"--note",
			"Truncated mid-sentence; the meaning is intact",
		];
		const row = () =>
			db
				.select()
				.from(schema.summaries)
				.where(eq(schema.summaries.meetingId, 1))
				.get();

		t.note("Without --confirm: a preview, and nothing written.");
		const dry = await t.run(url, release);
		expect(dry.code).toBe(0);
		expect(dry.stdout).toContain("status:        held -> published");
		expect(dry.stdout).toContain("dry run");
		expect((await row())?.status).toBe("held");
		expect((await row())?.releasedAt).toBeNull();
		expect(await listRecentMeetingsQuery(db)).toEqual([]);

		t.note("With --confirm: published, with released_at and release_note.");
		const done = await t.run(url, [...release, "--confirm"]);
		expect(done.code).toBe(0);
		expect(done.stdout).toContain("released.");
		const released = await row();
		expect(released?.status).toBe("published");
		expect(released?.heldReason).toBeNull();
		expect(released?.releasedAt).toBeInstanceOf(Date);
		expect(released?.releaseNote).toBe(
			"Truncated mid-sentence; the meaning is intact",
		);
		expect(released?.prose).toBe(TRUNCATED.prose);

		t.note("The meeting is back in the reader's list, and no longer held.");
		const lists = await listRecentMeetingsQuery(db);
		expect(lists.map((m) => m.date)).toEqual(["2025-05-27"]);
		const after = await t.run(url, ["summaries:held"]);
		expect(after.stderr).toContain("No held summaries.");

		t.note("Releasing again is refused: the summary is not held.");
		const again = await t.run(url, [...release, "--confirm"]);
		expect(again.code).not.toBe(0);
		expect(again.stderr).toContain("is not held");
		t.save();
	}, 60_000);
});
