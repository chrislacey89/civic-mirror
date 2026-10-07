import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import { DatabaseError } from "#/pipeline/errors.ts";
import { computeSourceFingerprint } from "#/pipeline/sources.ts";
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

		it("stores two sessions on one date as two meetings, each with its own summary", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			const session = (name: string, docId: string) => ({
				bodySlug: "ellettsville-town-council",
				date: "2026-01-20",
				session: name,
				meetingType: "regular" as const,
				documents: [
					{
						sourceUrl: `/fs/resource-manager/view/${docId}`,
						rawText: `Minutes of the ${name}.`,
						documentType: "minutes" as const,
						extractionMethod: "text-layer" as const,
					},
				],
				summary: {
					highlights: [`${name} highlight`],
					prose: `${name} prose`,
					model: "gemini-2.5-flash",
				},
			});

			const [finance, regular] = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return [
						yield* storage.storeMeeting(session("board-of-finance", "uuid-a")),
						yield* storage.storeMeeting(session("regular-meeting", "uuid-b")),
					];
				}).pipe(Effect.provide(layer)),
			);

			expect(regular.id).not.toBe(finance.id);
			const summaries = await db.select().from(schema.summaries).all();
			expect(summaries.map((s) => s.prose).sort()).toEqual([
				"board-of-finance prose",
				"regular-meeting prose",
			]);
		});

		it("reuses a same-day meeting that already holds one of the documents, whatever its session", async () => {
			const db = await createTestDb();
			const layer = StorageServiceLive(db);

			const doc = (id: string) => ({
				sourceUrl: `/fs/resource-manager/view/${id}`,
				rawText: `Text of ${id}.`,
				documentType: "minutes" as const,
				extractionMethod: "text-layer" as const,
			});
			const base = {
				bodySlug: "ellettsville-town-council",
				date: "2026-04-21",
				meetingType: "regular" as const,
			};

			const [first, relabelled] = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return [
						yield* storage.storeMeeting({
							...base,
							session: "regular-meeting-6-00-pm",
							documents: [doc("uuid-agenda")],
						}),
						yield* storage.storeMeeting({
							...base,
							session: "regular-meeting-6-30-pm",
							documents: [doc("uuid-agenda"), doc("uuid-minutes")],
						}),
					];
				}).pipe(Effect.provide(layer)),
			);

			expect(relabelled.id).toBe(first.id);
			expect(await db.select().from(schema.meetings).all()).toHaveLength(1);
			expect(await db.select().from(schema.documents).all()).toHaveLength(2);
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

	describe("summary sources", () => {
		const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";
		const videoOnlyInput = {
			bodySlug: "ellettsville-town-council",
			date: "2025-08-25",
			meetingType: "regular" as const,
			documents: [],
			summary: {
				highlights: ["Discussed the wheel tax"],
				prose: "The council discussed a wheel tax.",
				model: "gemini-2.5-flash",
				sourceKinds: ["transcript" as const],
				sourceFingerprint: computeSourceFingerprint([VIDEO_URL]),
			},
		};

		it("stores the source kinds and fingerprint a summary was built from", async () => {
			const db = await createTestDb();

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeMeeting(videoOnlyInput);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			const rows = await db.select().from(schema.summaries).all();
			expect(rows).toHaveLength(1);
			expect(rows[0].sourceKinds).toEqual(["transcript"]);
			expect(rows[0].sourceFingerprint).toBe(
				computeSourceFingerprint([VIDEO_URL]),
			);
			expect(rows[0].sourceDisagreements).toEqual([]);
		});

		it("reads a summary written before the source columns existed as having no recorded sources", async () => {
			// Migrate to the schema as it stood before 0007, write a summary
			// there, then apply 0007 over it.
			const before = fs.mkdtempSync(path.join(os.tmpdir(), "cm-migrations-"));
			fs.cpSync("./drizzle", before, { recursive: true });
			const journalPath = path.join(before, "meta", "_journal.json");
			const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
			journal.entries = journal.entries.filter(
				(e: { idx: number }) => e.idx < 7,
			);
			fs.writeFileSync(journalPath, JSON.stringify(journal));

			const tmpFile = path.join(
				os.tmpdir(),
				`civic-mirror-test-${process.pid}-${dbCounter++}.db`,
			);
			tmpFiles.push(tmpFile);
			const client = createClient({ url: `file:${tmpFile}` });
			const db = drizzle(client, { schema });
			await migrate(db, { migrationsFolder: before });
			fs.rmSync(before, { recursive: true });

			await client.executeMultiple(`
				insert into governing_bodies (name, slug, type) values ('Town Council', 'tc', 'town');
				insert into meetings (body_id, date) values (1, '2025-06-09');
				insert into summaries (meeting_id, highlights, prose, model) values (1, '["h"]', 'p', 'm');
			`);

			await migrate(db, { migrationsFolder: "./drizzle" });

			const rows = await db.select().from(schema.summaries).all();
			expect(rows).toHaveLength(1);
			expect(rows[0].sourceKinds).toEqual([]);
			expect(rows[0].sourceFingerprint).toBe("");
			expect(rows[0].sourceDisagreements).toEqual([]);
		});

		it("refuses a second summary for a meeting", async () => {
			const db = await createTestDb();
			const meeting = await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(videoOnlyInput);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			await expect(
				db
					.insert(schema.summaries)
					.values({
						meetingId: meeting.id,
						highlights: [],
						prose: "a second summary",
						model: "m",
					})
					.run(),
			).rejects.toMatchObject({
				// DrizzleQueryError wraps the driver error; the constraint detail is on `cause`.
				cause: {
					extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
					message: expect.stringContaining("summaries.meeting_id"),
				},
			});
		});
	});

	describe("getMeetingSourceState", () => {
		const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";
		const key = {
			bodySlug: "ellettsville-town-council",
			date: "2026-03-23",
			session: "",
		};

		function read(
			db: Awaited<ReturnType<typeof createTestDb>>,
			input: { bodySlug: string; date: string; session: string },
		) {
			return Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.getMeetingSourceState(input);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
		}

		function store(
			db: Awaited<ReturnType<typeof createTestDb>>,
			input: Parameters<
				Effect.Success<typeof StorageService>["storeMeeting"]
			>[0],
		) {
			return Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.storeMeeting(input);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
		}

		it("returns null when the body has no meeting on that date and session", async () => {
			const db = await createTestDb();
			expect(await read(db, key)).toBeNull();
		});

		it("reports a meeting built from documents, with a summary that predates source kinds", async () => {
			const db = await createTestDb();
			const meeting = await store(db, testMeetingInput);

			expect(await read(db, key)).toEqual({
				meetingId: meeting.id,
				date: "2026-03-23",
				session: "",
				hasDocuments: true,
				transcriptSourceUrl: null,
				summarySourceKinds: [],
			});
		});

		it("reports a video-only meeting with its transcript URL and summary source kinds", async () => {
			const db = await createTestDb();
			const meeting = await store(db, {
				...testMeetingInput,
				documents: [],
				summary: {
					...testMeetingInput.summary,
					sourceKinds: ["transcript"],
					sourceFingerprint: computeSourceFingerprint([VIDEO_URL]),
				},
			});
			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					yield* storage.storeTranscript({
						meetingId: meeting.id,
						source: "captions",
						rawText: "transcript",
						sourceUrl: VIDEO_URL,
					});
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			expect(await read(db, key)).toEqual({
				meetingId: meeting.id,
				date: "2026-03-23",
				session: "",
				hasDocuments: false,
				transcriptSourceUrl: VIDEO_URL,
				summarySourceKinds: ["transcript"],
			});
		});

		it("does not report the regular meeting for another session on its date", async () => {
			const db = await createTestDb();
			await store(db, testMeetingInput);

			expect(
				await read(db, { ...key, session: "budget-work-session" }),
			).toBeNull();
		});

		it("does not report another body's meeting on the same date", async () => {
			const db = await createTestDb();
			await db
				.insert(schema.governingBodies)
				.values({ name: "Plan Commission", slug: "plan", type: "town" })
				.run();
			await store(db, testMeetingInput);

			expect(await read(db, { ...key, bodySlug: "plan" })).toBeNull();
		});
	});

	describe("hasTranscriptForVideo", () => {
		const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";

		function has(db: Awaited<ReturnType<typeof createTestDb>>, url: string) {
			return Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					return yield* storage.hasTranscriptForVideo(url);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
		}

		it("is true once a transcript with that source URL is stored, and false for any other URL", async () => {
			const db = await createTestDb();
			expect(await has(db, VIDEO_URL)).toBe(false);

			await Effect.runPromise(
				Effect.gen(function* () {
					const storage = yield* StorageService;
					const meeting = yield* storage.storeMeeting({
						...testMeetingInput,
						documents: [],
					});
					yield* storage.storeTranscript({
						meetingId: meeting.id,
						source: "captions",
						rawText: "transcript",
						sourceUrl: VIDEO_URL,
					});
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);

			expect(await has(db, VIDEO_URL)).toBe(true);
			expect(await has(db, "https://www.youtube.com/watch?v=other")).toBe(
				false,
			);
		});
	});

	describe("getMeetingSources", () => {
		const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";

		function run<A>(
			db: Awaited<ReturnType<typeof createTestDb>>,
			use: (
				storage: Effect.Success<typeof StorageService>,
			) => Effect.Effect<A, unknown>,
		) {
			return Effect.runPromise(
				Effect.gen(function* () {
					return yield* use(yield* StorageService);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
		}

		it("returns a meeting's documents, transcript, and the source kinds and fingerprint of its summary", async () => {
			const db = await createTestDb();
			const sources = await run(db, (storage) =>
				Effect.gen(function* () {
					const meeting = yield* storage.storeMeeting({
						...testMeetingInput,
						summary: {
							...testMeetingInput.summary,
							sourceKinds: ["documents", "transcript"],
							sourceFingerprint: "fingerprint-1",
						},
					});
					yield* storage.storeTranscript({
						meetingId: meeting.id,
						source: "captions",
						rawText: "transcript text",
						sourceUrl: VIDEO_URL,
					});
					return yield* storage.getMeetingSources(meeting.id);
				}),
			);

			expect(sources).toEqual({
				documents: [
					{
						sourceUrl: testMeetingInput.documents[0].sourceUrl,
						rawText: testMeetingInput.documents[0].rawText,
						documentType: "minutes",
						extractionMethod: "text-layer",
					},
				],
				transcript: { sourceUrl: VIDEO_URL, rawText: "transcript text" },
				summary: {
					sourceKinds: ["documents", "transcript"],
					sourceFingerprint: "fingerprint-1",
				},
			});
		});

		it("reports a documents-only legacy summary as having no recorded sources and no transcript", async () => {
			const db = await createTestDb();
			const sources = await run(db, (storage) =>
				Effect.gen(function* () {
					const meeting = yield* storage.storeMeeting(testMeetingInput);
					return yield* storage.getMeetingSources(meeting.id);
				}),
			);

			expect(sources.transcript).toBeNull();
			expect(sources.summary).toEqual({
				sourceKinds: [],
				sourceFingerprint: "",
			});
		});

		it("reports no summary for a meeting stored with only an unreadable document", async () => {
			const db = await createTestDb();
			const sources = await run(db, (storage) =>
				Effect.gen(function* () {
					const meeting = yield* storage.storeMeeting({
						bodySlug: "ellettsville-town-council",
						date: "2026-03-23",
						meetingType: "regular",
						documents: [
							{
								sourceUrl: "https://ellettsville.in.us/egov/docs/scan.pdf",
								rawText: "",
								documentType: "minutes",
								extractionMethod: "unreadable",
							},
						],
					});
					return yield* storage.getMeetingSources(meeting.id);
				}),
			);

			expect(sources.summary).toBeNull();
			expect(sources.documents).toHaveLength(1);
		});

		it("returns empty sources for a meeting id with no rows", async () => {
			const db = await createTestDb();
			expect(
				await run(db, (storage) => storage.getMeetingSources(999)),
			).toEqual({
				documents: [],
				transcript: null,
				summary: null,
			});
		});
	});

	describe("stampSummaryFingerprint", () => {
		function run<A>(
			db: Awaited<ReturnType<typeof createTestDb>>,
			use: (
				storage: Effect.Success<typeof StorageService>,
			) => Effect.Effect<A, unknown>,
		) {
			return Effect.runPromise(
				Effect.gen(function* () {
					return yield* use(yield* StorageService);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
		}

		it("sets the fingerprint on a summary stored without one and changes nothing else", async () => {
			const db = await createTestDb();
			const meeting = await run(db, (s) => s.storeMeeting(testMeetingInput));
			const before = await db.select().from(schema.summaries).all();
			expect(before[0].sourceFingerprint).toBe("");

			await run(db, (s) =>
				s.stampSummaryFingerprint({
					meetingId: meeting.id,
					sourceFingerprint: "stamped",
				}),
			);

			expect(await db.select().from(schema.summaries).all()).toEqual([
				{ ...before[0], sourceFingerprint: "stamped" },
			]);
		});

		it("leaves a summary that already has a fingerprint alone", async () => {
			const db = await createTestDb();
			const meeting = await run(db, (s) =>
				s.storeMeeting({
					...testMeetingInput,
					summary: {
						...testMeetingInput.summary,
						sourceFingerprint: "existing",
					},
				}),
			);

			await run(db, (s) =>
				s.stampSummaryFingerprint({
					meetingId: meeting.id,
					sourceFingerprint: "stamped",
				}),
			);

			const rows = await db.select().from(schema.summaries).all();
			expect(rows[0].sourceFingerprint).toBe("existing");
		});
	});

	describe("replaceMeetingSummary", () => {
		const replacement = {
			summary: {
				highlights: ["New highlight"],
				prose: "A rewritten summary.",
				model: "gemini-new",
			},
			fiscalDecisions: [
				{
					title: "New fiscal decision",
					description: "Approved a new thing",
					amount: 1000,
					originalAmount: "$1,000",
					status: "approved" as const,
					confidence: 0.8,
					isRecurring: false,
				},
			],
			budgetDiscussions: [{ topic: "New budget topic" }],
			sourceKinds: ["documents", "transcript"] as (
				| "documents"
				| "transcript"
			)[],
			sourceFingerprint: "fingerprint-new",
			sourceDisagreements: [
				{ topic: "Vote count", documentsSay: "4-1", transcriptSays: "5-0" },
			],
		};

		function run<A>(
			db: Awaited<ReturnType<typeof createTestDb>>,
			use: (
				storage: Effect.Success<typeof StorageService>,
			) => Effect.Effect<A, unknown>,
		) {
			return Effect.runPromise(
				Effect.gen(function* () {
					return yield* use(yield* StorageService);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
		}

		function store(
			db: Awaited<ReturnType<typeof createTestDb>>,
			input: Parameters<
				Effect.Success<typeof StorageService>["storeMeeting"]
			>[0],
		) {
			return run(db, (storage) => storage.storeMeeting(input));
		}

		it("replaces the meeting's summary, fiscal decisions, and budget discussions and leaves other meetings alone", async () => {
			const db = await createTestDb();
			const meeting = await store(db, testMeetingInput);
			const other = await store(db, {
				...testMeetingInput,
				date: "2026-04-13",
			});

			await run(db, (storage) =>
				storage.replaceMeetingSummary({
					meetingId: meeting.id,
					...replacement,
				}),
			);

			const summaries = await db
				.select()
				.from(schema.summaries)
				.where(eq(schema.summaries.meetingId, meeting.id))
				.all();
			expect(summaries).toHaveLength(1);
			expect(summaries[0]).toMatchObject({
				highlights: ["New highlight"],
				prose: "A rewritten summary.",
				model: "gemini-new",
				sourceKinds: ["documents", "transcript"],
				sourceFingerprint: "fingerprint-new",
				sourceDisagreements: replacement.sourceDisagreements,
			});
			const fiscal = await db
				.select()
				.from(schema.fiscalDecisions)
				.where(eq(schema.fiscalDecisions.meetingId, meeting.id))
				.all();
			expect(fiscal.map((f) => f.title)).toEqual(["New fiscal decision"]);
			const budget = await db
				.select()
				.from(schema.budgetDiscussions)
				.where(eq(schema.budgetDiscussions.meetingId, meeting.id))
				.all();
			expect(budget.map((b) => b.topic)).toEqual(["New budget topic"]);

			const otherSummary = await db
				.select()
				.from(schema.summaries)
				.where(eq(schema.summaries.meetingId, other.id))
				.all();
			expect(otherSummary).toHaveLength(1);
			expect(otherSummary[0].model).toBe("gemini-2.5-flash");
			const otherFiscal = await db
				.select()
				.from(schema.fiscalDecisions)
				.where(eq(schema.fiscalDecisions.meetingId, other.id))
				.all();
			expect(otherFiscal.map((f) => f.title)).toEqual([
				"Sale Street Road Repairs",
			]);
			const otherBudget = await db
				.select()
				.from(schema.budgetDiscussions)
				.where(eq(schema.budgetDiscussions.meetingId, other.id))
				.all();
			expect(otherBudget.map((b) => b.topic)).toEqual([
				"Park pavilion renovation",
			]);
		});

		it("keeps the previous summary, fiscal decisions, and budget discussions when a late insert fails", async () => {
			const db = await createTestDb();
			const meeting = await store(db, testMeetingInput);
			const snapshot = async () => ({
				summaries: await db.select().from(schema.summaries).all(),
				fiscal: await db.select().from(schema.fiscalDecisions).all(),
				budget: await db.select().from(schema.budgetDiscussions).all(),
			});
			const before = await snapshot();

			const error = await run(db, (storage) =>
				Effect.flip(
					storage.replaceMeetingSummary({
						meetingId: meeting.id,
						...replacement,
						// Rejected by NOT NULL after the deletes and earlier inserts have run.
						budgetDiscussions: [{ topic: null as unknown as string }],
					}),
				),
			);

			expect(error).toBeInstanceOf(DatabaseError);
			expect(error).toMatchObject({ operation: "replaceMeetingSummary" });
			expect(await snapshot()).toEqual(before);
		});

		it("lowers fiscal confidence when any attached document is OCR", async () => {
			const db = await createTestDb();
			const meeting = await store(db, {
				...testMeetingInput,
				documents: [
					{ ...testMeetingInput.documents[0], extractionMethod: "ocr" },
				],
			});

			await run(db, (storage) =>
				storage.replaceMeetingSummary({
					meetingId: meeting.id,
					...replacement,
				}),
			);

			const fiscal = await db.select().from(schema.fiscalDecisions).all();
			expect(fiscal).toHaveLength(1);
			expect(fiscal[0].confidence).toBeCloseTo(0.8 * OCR_CONFIDENCE_MULTIPLIER);
		});

		it("keeps fiscal confidence as given when no attached document is OCR", async () => {
			const db = await createTestDb();
			const meeting = await store(db, testMeetingInput);

			await run(db, (storage) =>
				storage.replaceMeetingSummary({
					meetingId: meeting.id,
					...replacement,
				}),
			);

			const fiscal = await db.select().from(schema.fiscalDecisions).all();
			expect(fiscal[0].confidence).toBe(0.8);
		});

		it("inserts a summary for a meeting that has none yet", async () => {
			const db = await createTestDb();
			const meeting = await store(db, {
				bodySlug: "ellettsville-town-council",
				date: "2026-03-23",
				meetingType: "regular",
				documents: [
					{
						sourceUrl: "https://ellettsville.in.us/egov/docs/scan.pdf",
						rawText: "",
						documentType: "minutes",
						extractionMethod: "unreadable",
					},
				],
			});
			expect(await db.select().from(schema.summaries).all()).toHaveLength(0);

			await run(db, (storage) =>
				storage.replaceMeetingSummary({
					meetingId: meeting.id,
					...replacement,
				}),
			);

			const summaries = await db.select().from(schema.summaries).all();
			expect(summaries).toHaveLength(1);
			expect(summaries[0].meetingId).toBe(meeting.id);
			expect(summaries[0].prose).toBe("A rewritten summary.");
		});
	});

	describe("held videos", () => {
		const held = {
			bodySlug: "ellettsville-town-council",
			videoId: "vid-held-1",
			title: "Ellettsville Town Council, March 23, 2026",
			meetingDate: "2026-03-23",
			reason: "no-captions" as const,
		};

		function run<A>(
			db: Awaited<ReturnType<typeof createTestDb>>,
			use: (
				storage: Effect.Success<typeof StorageService>,
			) => Effect.Effect<A, DatabaseError>,
		) {
			return Effect.runPromise(
				Effect.gen(function* () {
					return yield* use(yield* StorageService);
				}).pipe(Effect.provide(StorageServiceLive(db))),
			);
		}

		it("holdVideo called twice for one videoId leaves one row and returns created: false the second time", async () => {
			const db = await createTestDb();

			const first = await run(db, (s) => s.holdVideo(held));
			const second = await run(db, (s) =>
				s.holdVideo({ ...held, reason: "unrecognized-title" }),
			);

			expect(first).toEqual({ created: true });
			expect(second).toEqual({ created: false });
			const rows = await db.select().from(schema.heldVideos).all();
			expect(rows).toHaveLength(1);
			expect(rows[0].reason).toBe("no-captions");
		});

		it("isVideoHeld is true for a held video and false for any other", async () => {
			const db = await createTestDb();
			expect(await run(db, (s) => s.isVideoHeld(held.videoId))).toBe(false);

			await run(db, (s) => s.holdVideo(held));

			expect(await run(db, (s) => s.isVideoHeld(held.videoId))).toBe(true);
			expect(await run(db, (s) => s.isVideoHeld("vid-other"))).toBe(false);
		});

		it("listHeldVideos returns every held video with what it was held with, and only one body's when given a slug", async () => {
			const db = await createTestDb();
			await db
				.insert(schema.governingBodies)
				.values({ name: "Plan Commission", slug: "plan", type: "town" })
				.run();
			const meeting = await run(db, (s) =>
				s.storeMeeting({ ...testMeetingInput, documents: [] }),
			);
			const checked = {
				bodySlug: "plan",
				videoId: "vid-held-2",
				title: "Plan Commission, April 2, 2026",
				meetingDate: null,
				reason: "signals-disagree" as const,
				probability: 0.8,
				sharedIdentifiers: 0,
				candidateMeetingId: meeting.id,
			};
			await run(db, (s) => s.holdVideo(held));
			await run(db, (s) => s.holdVideo(checked));

			const all = await run(db, (s) => s.listHeldVideos());
			const planOnly = await run(db, (s) =>
				s.listHeldVideos({ bodySlug: "plan" }),
			);

			expect(all.map(({ createdAt: _, ...rest }) => rest)).toEqual([
				held,
				checked,
			]);
			expect(all[0].createdAt).toBeInstanceOf(Date);
			expect(planOnly.map((v) => v.videoId)).toEqual(["vid-held-2"]);
		});
	});
});
