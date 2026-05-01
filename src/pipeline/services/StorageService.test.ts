import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import {
	OCR_CONFIDENCE_MULTIPLIER,
	StorageService,
	StorageServiceLive,
} from "./StorageService.ts";

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
			extractionMethod: "text-layer" as const,
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

			// Default extraction method is preserved on the document row
			expect(docs[0].extractionMethod).toBe("text-layer");
		});

		it("persists an unreadable meeting with the document row but no summary or fiscal data", async () => {
			const db = await createTestDb();
			const unreadableInput = {
				bodySlug: "ellettsville-town-council",
				date: "2024-05-13",
				meetingType: "regular" as const,
				documents: [
					{
						sourceUrl:
							"https://ellettsville.in.us/egov/docs/scanned-2024-05-13.pdf",
						rawText: "",
						documentType: "minutes" as const,
						extractionMethod: "unreadable" as const,
					},
				],
				// No summary, fiscalDecisions, or budgetDiscussions — the meeting
				// is reachable via its PDF link but the upstream pipeline did not
				// produce any LLM output.
			};

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(unreadableInput);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			const meetings = await db.select().from(schema.meetings).all();
			expect(meetings).toHaveLength(1);

			const docs = await db.select().from(schema.documents).all();
			expect(docs).toHaveLength(1);
			expect(docs[0].extractionMethod).toBe("unreadable");
			expect(docs[0].rawText).toBe("");

			const summaries = await db.select().from(schema.summaries).all();
			expect(summaries).toHaveLength(0);
			const fiscals = await db.select().from(schema.fiscalDecisions).all();
			expect(fiscals).toHaveLength(0);
			const discussions = await db
				.select()
				.from(schema.budgetDiscussions)
				.all();
			expect(discussions).toHaveLength(0);
		});

		it("rejects a document that claims 'text-layer' or 'ocr' but has empty rawText", async () => {
			const db = await createTestDb();
			const brokenInput = {
				...testMeetingInput,
				documents: [
					{
						...testMeetingInput.documents[0],
						rawText: "",
						extractionMethod: "text-layer" as const,
					},
				],
			};

			const program = Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.storeMeeting(brokenInput);
			}).pipe(Effect.provide(StorageServiceLive(db)));

			await expect(Effect.runPromise(program)).rejects.toThrow(
				/invariant|unreadable/i,
			);

			// And nothing was written — the assertion fires before the transaction.
			const meetings = await db.select().from(schema.meetings).all();
			expect(meetings).toHaveLength(0);
		});

		it("applies the OCR confidence multiplier to fiscal decisions when any source doc is OCR", async () => {
			const db = await createTestDb();
			const ocrInput = {
				...testMeetingInput,
				date: "2025-09-09",
				documents: [
					{
						...testMeetingInput.documents[0],
						extractionMethod: "ocr" as const,
					},
				],
			};

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(ocrInput);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			const fiscals = await db.select().from(schema.fiscalDecisions).all();
			expect(fiscals).toHaveLength(1);
			// testMeetingInput.fiscalDecisions[0].confidence === 0.95
			expect(fiscals[0].confidence).toBeCloseTo(
				0.95 * OCR_CONFIDENCE_MULTIPLIER,
				5,
			);
		});

		it("attaches new documents to an existing meeting when a later call brings siblings (agenda + ordinance)", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			// First call: a meeting with its minutes document.
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeMeeting({
						bodySlug: "ellettsville-town-council",
						date: "2025-12-22",
						meetingType: "regular",
						documents: [
							{
								sourceUrl: "https://ellettsville.in.us/egov/docs/1628.pdf",
								rawText: "Minutes for the Dec 22 meeting.",
								documentType: "minutes",
								extractionMethod: "text-layer",
							},
						],
					});
				}).pipe(Effect.provide(layer)),
			);

			// Second call for the *same* meeting, different document (agenda).
			// The storage layer must attach it to the existing meeting instead
			// of dropping it via the idempotency short-circuit. See issue #27.
			const secondHandle = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting({
						bodySlug: "ellettsville-town-council",
						date: "2025-12-22",
						meetingType: "regular",
						documents: [
							{
								sourceUrl: "https://ellettsville.in.us/egov/docs/1700.pdf",
								rawText: "Agenda for the Dec 22 meeting.",
								documentType: "agenda",
								extractionMethod: "text-layer",
							},
						],
					});
				}).pipe(Effect.provide(layer)),
			);

			const meetings = await db.select().from(schema.meetings).all();
			expect(meetings).toHaveLength(1);
			expect(secondHandle.id).toBe(meetings[0].id);

			const docs = await db.select().from(schema.documents).all();
			expect(docs).toHaveLength(2);
			expect(docs.map((d) => d.documentType).sort()).toEqual([
				"agenda",
				"minutes",
			]);
		});

		it("does not duplicate a document when the same (meetingId, sourceUrl) is re-submitted", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			const firstInput = {
				bodySlug: "ellettsville-town-council",
				date: "2025-12-22",
				meetingType: "regular" as const,
				documents: [
					{
						sourceUrl: "https://ellettsville.in.us/egov/docs/1628.pdf",
						rawText: "Minutes text v1.",
						documentType: "minutes" as const,
						extractionMethod: "text-layer" as const,
					},
				],
			};

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeMeeting(firstInput);
					yield* storage.storeMeeting(firstInput);
				}).pipe(Effect.provide(layer)),
			);

			const docs = await db.select().from(schema.documents).all();
			expect(docs).toHaveLength(1);
		});

		it("is idempotent on re-run — second call with same (bodySlug, date) produces no duplicates", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			const first = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(testMeetingInput);
				}).pipe(Effect.provide(layer)),
			);

			const second = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(testMeetingInput);
				}).pipe(Effect.provide(layer)),
			);

			// Second call returns the same meeting handle as the first
			expect(second.id).toBe(first.id);

			// Exactly one meeting row survives — not two
			const meetings = await db.select().from(schema.meetings).all();
			expect(meetings).toHaveLength(1);

			// Child rows are not duplicated either
			const docs = await db.select().from(schema.documents).all();
			expect(docs).toHaveLength(testMeetingInput.documents.length);
			const summaries = await db.select().from(schema.summaries).all();
			expect(summaries).toHaveLength(1);
			const fiscals = await db.select().from(schema.fiscalDecisions).all();
			expect(fiscals).toHaveLength(testMeetingInput.fiscalDecisions.length);
			const discussions = await db
				.select()
				.from(schema.budgetDiscussions)
				.all();
			expect(discussions).toHaveLength(
				testMeetingInput.budgetDiscussions.length,
			);
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
			expect(result?.summary?.prose).toContain("Sale Street");
			expect(result?.summary?.highlights).toHaveLength(2);
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

	describe("getMostRecentMeetingDate", () => {
		it("returns the ISO date of the most recent meeting for a body", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			// Store two meetings for the same body, different dates
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeMeeting({
						...testMeetingInput,
						date: "2026-01-15",
					});
					yield* storage.storeMeeting({
						...testMeetingInput,
						date: "2026-03-23",
					});
				}).pipe(Effect.provide(layer)),
			);

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.getMostRecentMeetingDate(
						"ellettsville-town-council",
					);
				}).pipe(Effect.provide(layer)),
			);

			expect(result).toBe("2026-03-23");
		});

		it("returns null when the body has no meetings yet", async () => {
			const db = await createTestDb();
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.getMostRecentMeetingDate(
						"ellettsville-town-council",
					);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			expect(result).toBeNull();
		});

		it("returns null when the body slug does not exist", async () => {
			const db = await createTestDb();
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.getMostRecentMeetingDate("nonexistent-body");
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

		it("is idempotent on re-run — second call with same (meetingId, source) produces no duplicate", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			const meeting = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(testMeetingInput);
				}).pipe(Effect.provide(layer)),
			);

			const transcriptInput = {
				meetingId: meeting.id,
				source: "captions" as const,
				rawText: "Meeting called to order.",
				sourceUrl: "https://youtube.com/watch?v=test123",
			};

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeTranscript(transcriptInput);
					yield* storage.storeTranscript(transcriptInput);
				}).pipe(Effect.provide(layer)),
			);

			const transcripts = await db.select().from(schema.transcripts).all();
			expect(transcripts).toHaveLength(1);
		});
	});

	describe("storeDramaAssessment", () => {
		const ZERO_SCORES = {
			procedural_breakdown: { score: 0 as const, evidenceQuotes: [] },
			question_looping: { score: 0 as const, evidenceQuotes: [] },
			defensive_hedging: { score: 0 as const, evidenceQuotes: [] },
			timeline_pressure: { score: 0 as const, evidenceQuotes: [] },
			improvised_workarounds: { score: 0 as const, evidenceQuotes: [] },
			visible_dissent: { score: 0 as const, evidenceQuotes: [] },
			post_hoc_corrections: { score: 0 as const, evidenceQuotes: [] },
		};

		async function seedMeeting(db: Awaited<ReturnType<typeof createTestDb>>) {
			const layer = StorageServiceLive(db);
			return await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(testMeetingInput);
				}).pipe(Effect.provide(layer)),
			);
		}

		it("inserts an assessment row plus all 7 category-score rows for a routine meeting", async () => {
			const db = await createTestDb();
			const meeting = await seedMeeting(db);
			const layer = StorageServiceLive(db);

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeDramaAssessment({
						meetingId: meeting.id,
						level: "routine",
						confidence: 0.85,
						promptVersion: "v1",
						model: "gemini-2.5-flash",
						headline: "Council adopts agenda; meeting concludes in 32 minutes",
						narrative: "All items moved without objection.",
						categoryScores: ZERO_SCORES,
					});
				}).pipe(Effect.provide(layer)),
			);

			const assessments = await db.select().from(schema.dramaAssessments).all();
			expect(assessments).toHaveLength(1);
			expect(assessments[0].level).toBe("routine");
			expect(assessments[0].promptVersion).toBe("v1");

			const scores = await db.select().from(schema.dramaCategoryScores).all();
			expect(scores).toHaveLength(7);
			expect(scores.every((s) => s.score === 0)).toBe(true);
		});

		it("is idempotent on (meetingId, promptVersion, model)", async () => {
			const db = await createTestDb();
			const meeting = await seedMeeting(db);
			const layer = StorageServiceLive(db);

			const input = {
				meetingId: meeting.id,
				level: "routine" as const,
				confidence: 0.85,
				promptVersion: "v1",
				model: "gemini-2.5-flash",
				headline: "h",
				narrative: "n",
				categoryScores: ZERO_SCORES,
			};

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeDramaAssessment(input);
					yield* storage.storeDramaAssessment(input);
				}).pipe(Effect.provide(layer)),
			);

			const assessments = await db.select().from(schema.dramaAssessments).all();
			expect(assessments).toHaveLength(1);
			const scores = await db.select().from(schema.dramaCategoryScores).all();
			expect(scores).toHaveLength(7);
		});

		it("auto-publishes routine, bumpy, and heated; queues off-the-rails", async () => {
			const db = await createTestDb();
			const meeting = await seedMeeting(db);
			const layer = StorageServiceLive(db);

			// Heated assessment — sum of 12 → heated
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeDramaAssessment({
						meetingId: meeting.id,
						level: "heated",
						confidence: 0.8,
						promptVersion: "v1",
						model: "model-a",
						headline: "h",
						narrative: "n",
						categoryScores: {
							...ZERO_SCORES,
							procedural_breakdown: { score: 3, evidenceQuotes: ["q"] },
							question_looping: { score: 3, evidenceQuotes: ["q"] },
							visible_dissent: { score: 3, evidenceQuotes: ["q"] },
							post_hoc_corrections: { score: 3, evidenceQuotes: ["q"] },
						},
					});
					// Off-the-rails — sum of 21
					yield* storage.storeDramaAssessment({
						meetingId: meeting.id,
						level: "off-the-rails",
						confidence: 0.95,
						promptVersion: "v1",
						model: "model-b",
						headline: "h",
						narrative: "n",
						categoryScores: {
							procedural_breakdown: { score: 3, evidenceQuotes: ["q"] },
							question_looping: { score: 3, evidenceQuotes: ["q"] },
							defensive_hedging: { score: 3, evidenceQuotes: ["q"] },
							timeline_pressure: { score: 3, evidenceQuotes: ["q"] },
							improvised_workarounds: { score: 3, evidenceQuotes: ["q"] },
							visible_dissent: { score: 3, evidenceQuotes: ["q"] },
							post_hoc_corrections: { score: 3, evidenceQuotes: ["q"] },
						},
					});
				}).pipe(Effect.provide(layer)),
			);

			const rows = await db.select().from(schema.dramaAssessments).all();
			const heated = rows.find((r) => r.level === "heated");
			const offRails = rows.find((r) => r.level === "off-the-rails");
			expect(heated?.publishedAt).toBeInstanceOf(Date);
			expect(offRails?.publishedAt).toBeNull();
		});

		it("overrides level on insert when input disagrees with the sum", async () => {
			const db = await createTestDb();
			const meeting = await seedMeeting(db);
			const layer = StorageServiceLive(db);

			// LLM-emitted "off-the-rails" but actual sum is 3 → routine
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeDramaAssessment({
						meetingId: meeting.id,
						level: "off-the-rails",
						confidence: 0.4,
						promptVersion: "v1",
						model: "model-x",
						headline: "h",
						narrative: "n",
						categoryScores: {
							...ZERO_SCORES,
							visible_dissent: { score: 3, evidenceQuotes: ["q"] },
						},
					});
				}).pipe(Effect.provide(layer)),
			);

			const rows = await db.select().from(schema.dramaAssessments).all();
			expect(rows).toHaveLength(1);
			expect(rows[0].level).toBe("routine");
			// Routine auto-publishes
			expect(rows[0].publishedAt).toBeInstanceOf(Date);
		});
	});
});
