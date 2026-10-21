import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import { auditSummaries, formatAuditLine } from "#/pipeline/audit.ts";
import { PUBLISHED } from "#/pipeline/checks/test-outcomes.ts";
import {
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";
import { createMigratedTestDb } from "#/pipeline/test-db.ts";

const BODY = { slug: "town-council", name: "Town Council" };

async function setup() {
	const db = await createMigratedTestDb();
	await db
		.insert(schema.governingBodies)
		.values({ name: BODY.name, slug: BODY.slug, type: "town" })
		.run();
	const store = (date: string, prose: string) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.storeMeeting({
					bodySlug: BODY.slug,
					date,
					meetingType: "regular",
					documents: [
						{
							sourceUrl: `https://example.com/${date}.pdf`,
							rawText: `Minutes of ${date}.`,
							documentType: "minutes",
							extractionMethod: "text-layer",
						},
					],
					summary: {
						highlights: ["Council approves paving bid"],
						prose,
						model: "m",
						publication: PUBLISHED,
					},
					fiscalDecisions: [],
					budgetDiscussions: [],
				});
			}).pipe(Effect.provide(StorageServiceLive(db))),
		);
	await store("2025-05-27", "The council approved the paving bid for");
	await store("2025-06-09", "The council approved the paving bid.");
	const audit = (checkId?: "TRUNC" | "A1") =>
		Effect.runPromise(
			auditSummaries({ bodySlug: BODY.slug, checkId }).pipe(
				Effect.provide(StorageServiceLive(db)),
			),
		);
	return { db, audit };
}

describe("auditSummaries", () => {
	it("reports each failing verdict of the stored summaries, with its date and evidence", async () => {
		const { audit } = await setup();

		expect(await audit()).toEqual([
			{
				date: "2025-05-27",
				checkId: "TRUNC",
				verdict: {
					outcome: "fail",
					evidence: "The council approved the paving bid for",
				},
			},
		]);
	});

	it("reports only the check asked for", async () => {
		const { audit } = await setup();

		expect(await audit("A1")).toEqual([]);
		expect((await audit("TRUNC")).map((f) => f.date)).toEqual(["2025-05-27"]);
	});

	it("writes nothing", async () => {
		const { db, audit } = await setup();
		const snapshot = async () => ({
			meetings: await db.select().from(schema.meetings).all(),
			summaries: await db.select().from(schema.summaries).all(),
			rounds: await db.select().from(schema.summaryRounds).all(),
			fiscal: await db.select().from(schema.fiscalDecisions).all(),
			documents: await db.select().from(schema.documents).all(),
		});
		const before = await snapshot();

		await audit();

		expect(await snapshot()).toEqual(before);
	});
});

describe("formatAuditLine", () => {
	it("gives the date, the check id and the evidence", () => {
		expect(
			formatAuditLine({
				date: "2025-05-27",
				checkId: "TRUNC",
				verdict: { outcome: "fail", evidence: "approved the paving bid for" },
			}),
		).toBe("2025-05-27  TRUNC  approved the paving bid for");
	});

	it("gives the reason for an unchecked verdict", () => {
		expect(
			formatAuditLine({
				date: "2025-05-27",
				checkId: "A1",
				verdict: { outcome: "unchecked", reason: "no names list" },
			}),
		).toBe("2025-05-27  A1     unchecked: no names list");
	});
});
