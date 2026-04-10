import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import { StorageService, StorageServiceLive } from "./StorageService.ts";

const tmpFiles: string[] = [];

afterAll(() => {
	for (const f of tmpFiles) {
		try {
			fs.unlinkSync(f);
		} catch {}
	}
});

let dbCounter = 0;

async function createTestDb() {
	const tmpFile = path.join(
		os.tmpdir(),
		`civic-mirror-test-${process.pid}-${dbCounter++}.db`,
	);
	tmpFiles.push(tmpFile);
	const client = createClient({ url: `file:${tmpFile}` });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: "./drizzle" });

	// Seed one governing body for tests
	await db
		.insert(schema.governingBodies)
		.values({
			name: "Ellettsville Town Council",
			slug: "ellettsville-town-council",
			type: "town",
		})
		.run();

	return db;
}

const testMeetingInput = {
	bodySlug: "ellettsville-town-council",
	date: "2026-03-23",
	meetingType: "regular" as const,
	documents: [
		{
			sourceUrl: "https://ellettsville.in.us/egov/docs/123.pdf",
			rawText:
				"Meeting called to order. Motion to approve $50,000 for road repairs.",
			documentType: "minutes" as const,
		},
	],
	summary: {
		highlights: [
			"Approved $50,000 for Sale Street road repairs",
			"Tabled discussion on park renovations",
		],
		prose:
			"The Town Council met on March 23, 2026. The primary action was approval of $50,000 for road repairs on Sale Street.",
		model: "gemini-2.5-flash",
	},
	fiscalDecisions: [
		{
			title: "Sale Street Road Repairs",
			description: "Approved funding for road repairs on Sale Street",
			amount: 50000,
			originalAmount: "$50,000",
			budgetCategory: "infrastructure",
			status: "approved" as const,
			voteRecord: { yea: 4, nay: 1, abstain: 0 },
			confidence: 0.95,
			isRecurring: false,
		},
	],
	budgetDiscussions: [
		{
			topic: "Park pavilion renovation",
			estimatedAmount: 120000,
			notes: "Discussed but no vote taken. Expected vote at April meeting.",
		},
	],
};

describe("StorageService", () => {
	describe("storeMeeting", () => {
		it("rolls back all records when any part of the transaction fails", async () => {
			const db = await createTestDb();
			const badInput = {
				...testMeetingInput,
				bodySlug: "nonexistent-body", // will fail lookup
			};

			const program = Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.storeMeeting(badInput);
			}).pipe(Effect.provide(StorageServiceLive(db)));

			await expect(Effect.runPromise(program)).rejects.toThrow();

			// Nothing should have been written
			const meetings = await db.select().from(schema.meetings).all();
			expect(meetings).toHaveLength(0);
			const docs = await db.select().from(schema.documents).all();
			expect(docs).toHaveLength(0);
			const summaries = await db.select().from(schema.summaries).all();
			expect(summaries).toHaveLength(0);
		});

		it("writes meeting, document, summary, fiscal decisions, and budget discussions atomically", async () => {
			const db = await createTestDb();
			const program = Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.storeMeeting(testMeetingInput);
			}).pipe(Effect.provide(StorageServiceLive(db)));

			const meeting = await Effect.runPromise(program);

			// Verify meeting was created
			expect(meeting.id).toBeDefined();
			expect(meeting.date).toBe("2026-03-23");

			// Verify document was stored
			const docs = await db.select().from(schema.documents).all();
			expect(docs).toHaveLength(1);
			expect(docs[0].rawText).toContain("$50,000");

			// Verify summary was stored
			const summaries = await db.select().from(schema.summaries).all();
			expect(summaries).toHaveLength(1);
			expect(summaries[0].prose).toContain("Sale Street");

			// Verify fiscal decision was stored
			const fiscals = await db.select().from(schema.fiscalDecisions).all();
			expect(fiscals).toHaveLength(1);
			expect(fiscals[0].amount).toBe(50000);
			expect(fiscals[0].title).toBe("Sale Street Road Repairs");

			// Verify budget discussion was stored
			const discussions = await db
				.select()
				.from(schema.budgetDiscussions)
				.all();
			expect(discussions).toHaveLength(1);
			expect(discussions[0].topic).toBe("Park pavilion renovation");
		});
	});

	describe("getMeetingByBodyAndDate", () => {
		it("retrieves a full meeting with documents, summary, fiscal decisions, and discussions", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			// First store a meeting
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeMeeting(testMeetingInput);
				}).pipe(Effect.provide(layer)),
			);

			// Then retrieve it
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.getMeetingByBodyAndDate(
						"ellettsville-town-council",
						"2026-03-23",
					);
				}).pipe(Effect.provide(layer)),
			);

			expect(result).not.toBeNull();
			expect(result?.date).toBe("2026-03-23");
			expect(result?.bodyName).toBe("Ellettsville Town Council");
			expect(result?.documents).toHaveLength(1);
			expect(result?.summary.prose).toContain("Sale Street");
			expect(result?.summary.highlights).toHaveLength(2);
			expect(result?.fiscalDecisions).toHaveLength(1);
			expect(result?.fiscalDecisions[0].amount).toBe(50000);
			expect(result?.budgetDiscussions).toHaveLength(1);
		});

		it("returns null when no meeting exists", async () => {
			const db = await createTestDb();
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.getMeetingByBodyAndDate(
						"ellettsville-town-council",
						"2099-01-01",
					);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			expect(result).toBeNull();
		});
	});

	describe("storeTranscript", () => {
		it("stores a transcript linked to a meeting", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			// First store a meeting
			const meeting = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(testMeetingInput);
				}).pipe(Effect.provide(layer)),
			);

			// Store a transcript for that meeting
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeTranscript({
						meetingId: meeting.id,
						source: "captions",
						rawText: "Meeting called to order. Motion to approve.",
						segments: [
							{
								text: "Meeting called to order.",
								startMs: 0,
								durationMs: 3000,
							},
							{ text: "Motion to approve.", startMs: 3000, durationMs: 2000 },
						],
						sourceUrl: "https://youtube.com/watch?v=test123",
					});
				}).pipe(Effect.provide(layer)),
			);

			// Verify transcript was stored
			const transcripts = await db.select().from(schema.transcripts).all();
			expect(transcripts).toHaveLength(1);
			expect(transcripts[0].source).toBe("captions");
			expect(transcripts[0].rawText).toContain("Motion to approve");
			expect(transcripts[0].meetingId).toBe(meeting.id);
			expect(transcripts[0].sourceUrl).toBe(
				"https://youtube.com/watch?v=test123",
			);
		});

		it("stores a whisper transcript with segments", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			const meeting = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(testMeetingInput);
				}).pipe(Effect.provide(layer)),
			);

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeTranscript({
						meetingId: meeting.id,
						source: "whisper",
						rawText: "The council discussed budget.",
						segments: [
							{
								text: "The council discussed budget.",
								startMs: 0,
								durationMs: 5000,
							},
						],
					});
				}).pipe(Effect.provide(layer)),
			);

			const transcripts = await db.select().from(schema.transcripts).all();
			expect(transcripts).toHaveLength(1);
			expect(transcripts[0].source).toBe("whisper");
			expect(transcripts[0].segments).toEqual([
				{
					text: "The council discussed budget.",
					startMs: 0,
					durationMs: 5000,
				},
			]);
		});
	});
});
