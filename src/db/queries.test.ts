import { createClient } from "@libsql/client/http";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import {
	aggregateFiscalByBodyQuery,
	aggregateFiscalByCategoryForBodyQuery,
	aggregateFiscalByCategoryQuery,
	aggregateFiscalByTimePeriodQuery,
	getBodyWithStatsBySlugQuery,
	getMeetingByBodyAndDateQuery,
	listBodiesWithStatsQuery,
	listGoverningBodiesQuery,
	listNotableFiscalDecisionsQuery,
	listRecentMeetingsQuery,
} from "./queries.ts";

async function createTestDb() {
	const client = createClient({ url: ":memory:" });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: "./drizzle" });
	return db;
}

async function seedBody(
	db: Awaited<ReturnType<typeof createTestDb>>,
	overrides: Partial<typeof schema.governingBodies.$inferInsert> = {},
) {
	return await db
		.insert(schema.governingBodies)
		.values({
			name: "Ellettsville Town Council",
			slug: "ellettsville-town-council",
			type: "town",
			...overrides,
		})
		.returning()
		.get();
}

async function seedMeetingWithSummary(
	db: Awaited<ReturnType<typeof createTestDb>>,
	bodyId: number,
	date: string,
	opts: {
		highlights?: string[];
		prose?: string;
		fiscalDecisions?: Array<{
			title: string;
			amount: number;
			originalAmount: string;
			status?: "approved" | "denied" | "tabled";
			budgetCategory?: string;
		}>;
	} = {},
) {
	const meeting = await db
		.insert(schema.meetings)
		.values({ bodyId, date, meetingType: "regular" })
		.returning()
		.get();

	// A real pipeline always stores at least one document per meeting;
	// including a text-layer default here keeps derived extractionMethod
	// consistent with production state.
	await db
		.insert(schema.documents)
		.values({
			meetingId: meeting.id,
			sourceUrl: `https://example.gov/${date}.pdf`,
			rawText: "Document text.",
			documentType: "minutes",
			extractionMethod: "text-layer",
		})
		.run();

	await db
		.insert(schema.summaries)
		.values({
			meetingId: meeting.id,
			highlights: opts.highlights ?? ["Highlight one"],
			prose: opts.prose ?? "Summary prose.",
			model: "gemini-2.5-flash",
		})
		.run();

	for (const fd of opts.fiscalDecisions ?? []) {
		await db
			.insert(schema.fiscalDecisions)
			.values({
				meetingId: meeting.id,
				title: fd.title,
				description: `Description for ${fd.title}`,
				amount: fd.amount,
				originalAmount: fd.originalAmount,
				status: fd.status ?? "approved",
				budgetCategory: fd.budgetCategory ?? null,
				confidence: 0.95,
				isRecurring: false,
			})
			.run();
	}

	return meeting;
}

describe("listRecentMeetingsQuery", () => {
	it("returns meetings ordered by date descending", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-01-15");
		await seedMeetingWithSummary(db, body.id, "2026-03-23");
		await seedMeetingWithSummary(db, body.id, "2026-02-10");

		const result = await listRecentMeetingsQuery(db);

		expect(result).toHaveLength(3);
		expect(result[0].date).toBe("2026-03-23");
		expect(result[1].date).toBe("2026-02-10");
		expect(result[2].date).toBe("2026-01-15");
	});

	it("filters by body slug when provided", async () => {
		const db = await createTestDb();
		const council = await seedBody(db);
		const school = await seedBody(db, {
			name: "RBBSC School Board",
			slug: "rbbsc-school-board",
			type: "school",
		});
		await seedMeetingWithSummary(db, council.id, "2026-03-23");
		await seedMeetingWithSummary(db, school.id, "2026-03-20");
		await seedMeetingWithSummary(db, council.id, "2026-02-10");

		const result = await listRecentMeetingsQuery(db, "rbbsc-school-board");

		expect(result).toHaveLength(1);
		expect(result[0].bodySlug).toBe("rbbsc-school-board");
	});

	it("returns empty array for unknown body slug", async () => {
		const db = await createTestDb();
		await seedBody(db);

		const result = await listRecentMeetingsQuery(db, "nonexistent-body");

		expect(result).toHaveLength(0);
	});

	it("includes unreadable meetings without a summary, tagged by extractionMethod", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-03-23");
		// Insert an unreadable meeting: one document, no summary
		const unreadable = await db
			.insert(schema.meetings)
			.values({ bodyId: body.id, date: "2026-04-01", meetingType: "regular" })
			.returning()
			.get();
		await db
			.insert(schema.documents)
			.values({
				meetingId: unreadable.id,
				sourceUrl: "https://example.gov/scan.pdf",
				rawText: "",
				documentType: "minutes",
				extractionMethod: "unreadable",
			})
			.run();

		const result = await listRecentMeetingsQuery(db);

		expect(result).toHaveLength(2);
		const unreadableRow = result.find((r) => r.date === "2026-04-01");
		expect(unreadableRow?.extractionMethod).toBe("unreadable");
		expect(unreadableRow?.highlights).toEqual([]);
		expect(unreadableRow?.fiscalDecisionCount).toBe(0);
		const readableRow = result.find((r) => r.date === "2026-03-23");
		expect(readableRow?.extractionMethod).toBe("text-layer");
	});

	it("includes fiscal decision count and total spending", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{
					title: "Road Repairs",
					amount: 50000,
					originalAmount: "$50,000",
					budgetCategory: "infrastructure",
				},
				{
					title: "Park Equipment",
					amount: 25000,
					originalAmount: "$25,000",
					budgetCategory: "parks",
				},
			],
		});

		const result = await listRecentMeetingsQuery(db);

		expect(result[0].fiscalDecisionCount).toBe(2);
		expect(result[0].totalSpending).toBe(75000);
	});

	it("returns empty array when no meetings exist", async () => {
		const db = await createTestDb();

		const result = await listRecentMeetingsQuery(db);

		expect(result).toHaveLength(0);
	});
});

describe("aggregateFiscalByBodyQuery", () => {
	it("sums spending by governing body", async () => {
		const db = await createTestDb();
		const council = await seedBody(db);
		const school = await seedBody(db, {
			name: "RBBSC School Board",
			slug: "rbbsc-school-board",
			type: "school",
		});
		await seedMeetingWithSummary(db, council.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Roads", amount: 50000, originalAmount: "$50,000" },
			],
		});
		await seedMeetingWithSummary(db, school.id, "2026-03-20", {
			fiscalDecisions: [
				{ title: "Books", amount: 10000, originalAmount: "$10,000" },
				{ title: "Computers", amount: 20000, originalAmount: "$20,000" },
			],
		});

		const result = await aggregateFiscalByBodyQuery(db);

		expect(result).toHaveLength(2);
		const councilRow = result.find(
			(r) => r.bodySlug === "ellettsville-town-council",
		);
		const schoolRow = result.find((r) => r.bodySlug === "rbbsc-school-board");
		expect(councilRow?.totalAmount).toBe(50000);
		expect(councilRow?.decisionCount).toBe(1);
		expect(schoolRow?.totalAmount).toBe(30000);
		expect(schoolRow?.decisionCount).toBe(2);
	});

	it("returns empty array when no fiscal decisions exist", async () => {
		const db = await createTestDb();

		const result = await aggregateFiscalByBodyQuery(db);

		expect(result).toHaveLength(0);
	});
});

describe("aggregateFiscalByCategoryQuery", () => {
	it("sums spending by budget category", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{
					title: "Road Repairs",
					amount: 50000,
					originalAmount: "$50,000",
					budgetCategory: "infrastructure",
				},
				{
					title: "Sidewalks",
					amount: 30000,
					originalAmount: "$30,000",
					budgetCategory: "infrastructure",
				},
				{
					title: "Park Equipment",
					amount: 25000,
					originalAmount: "$25,000",
					budgetCategory: "parks",
				},
			],
		});

		const result = await aggregateFiscalByCategoryQuery(db);

		const infra = result.find((r) => r.budgetCategory === "infrastructure");
		const parks = result.find((r) => r.budgetCategory === "parks");
		expect(infra?.totalAmount).toBe(80000);
		expect(infra?.decisionCount).toBe(2);
		expect(parks?.totalAmount).toBe(25000);
		expect(parks?.decisionCount).toBe(1);
	});

	it("labels null categories as Uncategorized", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Misc", amount: 5000, originalAmount: "$5,000" },
			],
		});

		const result = await aggregateFiscalByCategoryQuery(db);

		expect(result[0].budgetCategory).toBe("Uncategorized");
	});
});

describe("aggregateFiscalByTimePeriodQuery", () => {
	it("sums spending by month ordered newest first", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-01-15", {
			fiscalDecisions: [
				{ title: "Jan item", amount: 10000, originalAmount: "$10,000" },
			],
		});
		await seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Mar item 1", amount: 50000, originalAmount: "$50,000" },
				{ title: "Mar item 2", amount: 20000, originalAmount: "$20,000" },
			],
		});

		const result = await aggregateFiscalByTimePeriodQuery(db);

		expect(result).toHaveLength(2);
		expect(result[0].period).toBe("2026-03");
		expect(result[0].totalAmount).toBe(70000);
		expect(result[1].period).toBe("2026-01");
		expect(result[1].totalAmount).toBe(10000);
	});
});

describe("listNotableFiscalDecisionsQuery", () => {
	it("returns decisions ordered by amount descending", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Small", amount: 5000, originalAmount: "$5,000" },
				{ title: "Big", amount: 100000, originalAmount: "$100,000" },
				{ title: "Medium", amount: 30000, originalAmount: "$30,000" },
			],
		});

		const result = await listNotableFiscalDecisionsQuery(db);

		expect(result[0].title).toBe("Big");
		expect(result[0].amount).toBe(100000);
		expect(result[1].title).toBe("Medium");
		expect(result[2].title).toBe("Small");
	});

	it("includes body name and meeting date", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Item", amount: 50000, originalAmount: "$50,000" },
			],
		});

		const result = await listNotableFiscalDecisionsQuery(db);

		expect(result[0].bodyName).toBe("Ellettsville Town Council");
		expect(result[0].date).toBe("2026-03-23");
	});

	it("respects limit parameter", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "A", amount: 1000, originalAmount: "$1,000" },
				{ title: "B", amount: 2000, originalAmount: "$2,000" },
				{ title: "C", amount: 3000, originalAmount: "$3,000" },
			],
		});

		const result = await listNotableFiscalDecisionsQuery(db, 2);

		expect(result).toHaveLength(2);
	});
});

describe("getMeetingByBodyAndDateQuery — extractionMethod", () => {
	async function seedMeetingWithDocs(
		db: Awaited<ReturnType<typeof createTestDb>>,
		bodyId: number,
		date: string,
		docs: Array<{
			sourceUrl: string;
			rawText: string;
			documentType: "agenda" | "minutes" | "ordinance";
			extractionMethod: "text-layer" | "ocr" | "unreadable";
		}>,
		summary?: { highlights: string[]; prose: string },
	) {
		const meeting = await db
			.insert(schema.meetings)
			.values({ bodyId, date, meetingType: "regular" })
			.returning()
			.get();

		for (const d of docs) {
			await db
				.insert(schema.documents)
				.values({
					meetingId: meeting.id,
					sourceUrl: d.sourceUrl,
					rawText: d.rawText,
					documentType: d.documentType,
					extractionMethod: d.extractionMethod,
				})
				.run();
		}

		if (summary) {
			await db
				.insert(schema.summaries)
				.values({
					meetingId: meeting.id,
					highlights: summary.highlights,
					prose: summary.prose,
					model: "gemini-2.5-flash",
				})
				.run();
		}

		return meeting;
	}

	it("returns extractionMethod='text-layer' when all docs use text layer", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithDocs(
			db,
			body.id,
			"2026-03-23",
			[
				{
					sourceUrl: "https://example.gov/a.pdf",
					rawText: "Agenda text.",
					documentType: "agenda",
					extractionMethod: "text-layer",
				},
			],
			{ highlights: ["h1"], prose: "prose" },
		);

		const result = await getMeetingByBodyAndDateQuery(
			db,
			"ellettsville-town-council",
			"2026-03-23",
		);

		expect(result).not.toBeNull();
		expect(result?.extractionMethod).toBe("text-layer");
		expect(result?.summary).not.toBeNull();
	});

	it("returns extractionMethod='ocr' when any doc was extracted via OCR", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithDocs(
			db,
			body.id,
			"2026-03-23",
			[
				{
					sourceUrl: "https://example.gov/a.pdf",
					rawText: "Agenda text.",
					documentType: "agenda",
					extractionMethod: "text-layer",
				},
				{
					sourceUrl: "https://example.gov/m.pdf",
					rawText: "Scanned minutes text.",
					documentType: "minutes",
					extractionMethod: "ocr",
				},
			],
			{ highlights: ["h1"], prose: "prose" },
		);

		const result = await getMeetingByBodyAndDateQuery(
			db,
			"ellettsville-town-council",
			"2026-03-23",
		);

		expect(result?.extractionMethod).toBe("ocr");
	});

	it("returns extractionMethod='unreadable' with no summary when all docs are unreadable", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithDocs(db, body.id, "2026-03-23", [
			{
				sourceUrl: "https://example.gov/scan.pdf",
				rawText: "",
				documentType: "minutes",
				extractionMethod: "unreadable",
			},
		]);

		const result = await getMeetingByBodyAndDateQuery(
			db,
			"ellettsville-town-council",
			"2026-03-23",
		);

		expect(result).not.toBeNull();
		expect(result?.extractionMethod).toBe("unreadable");
		expect(result?.summary).toBeNull();
		expect(result?.fiscalDecisions).toHaveLength(0);
		expect(result?.budgetDiscussions).toHaveLength(0);
		expect(result?.documents).toHaveLength(1);
	});

	it("returns null when the meeting does not exist", async () => {
		const db = await createTestDb();
		await seedBody(db);

		const result = await getMeetingByBodyAndDateQuery(
			db,
			"ellettsville-town-council",
			"1999-01-01",
		);

		expect(result).toBeNull();
	});
});

describe("listGoverningBodiesQuery", () => {
	it("returns all bodies ordered by name", async () => {
		const db = await createTestDb();
		await seedBody(db, {
			name: "Zebra Board",
			slug: "zebra-board",
			type: "county",
		});
		await seedBody(db, {
			name: "Alpha Council",
			slug: "alpha-council",
			type: "town",
		});

		const result = await listGoverningBodiesQuery(db);

		expect(result).toHaveLength(2);
		expect(result[0].name).toBe("Alpha Council");
		expect(result[1].name).toBe("Zebra Board");
	});
});

describe("listBodiesWithStatsQuery", () => {
	it("returns each body with correct meeting count and fiscal totals", async () => {
		const db = await createTestDb();
		const town = await seedBody(db);
		const county = await seedBody(db, {
			name: "Monroe County Council",
			slug: "monroe-county-council",
			type: "county",
		});

		await seedMeetingWithSummary(db, town.id, "2026-01-15", {
			fiscalDecisions: [
				{ title: "Sale Street", amount: 287400, originalAmount: "$287,400" },
				{ title: "Parks mower", amount: 42000, originalAmount: "$42,000" },
			],
		});
		await seedMeetingWithSummary(db, town.id, "2026-02-15", {
			fiscalDecisions: [
				{ title: "Sidewalks", amount: 96500, originalAmount: "$96,500" },
			],
		});
		await seedMeetingWithSummary(db, county.id, "2026-03-01", {
			fiscalDecisions: [
				{ title: "ARPA", amount: 2400000, originalAmount: "$2.4M" },
			],
		});

		const result = await listBodiesWithStatsQuery(db);

		expect(result).toHaveLength(2);
		const townResult = result.find((b) => b.slug === town.slug);
		const countyResult = result.find((b) => b.slug === county.slug);
		expect(townResult).toMatchObject({
			meetingCount: 2,
			decisionCount: 3,
			totalSpending: 425900,
		});
		expect(countyResult).toMatchObject({
			meetingCount: 1,
			decisionCount: 1,
			totalSpending: 2400000,
		});
	});

	it("returns zeros for a body with no meetings or decisions", async () => {
		const db = await createTestDb();
		await seedBody(db);

		const result = await listBodiesWithStatsQuery(db);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			meetingCount: 0,
			decisionCount: 0,
			totalSpending: 0,
		});
	});

	it("handles a body with meetings but no fiscal decisions", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-04-01");
		await seedMeetingWithSummary(db, body.id, "2026-04-15");

		const result = await listBodiesWithStatsQuery(db);

		expect(result[0]).toMatchObject({
			meetingCount: 2,
			decisionCount: 0,
			totalSpending: 0,
		});
	});

	it("returns bodies sorted by name", async () => {
		const db = await createTestDb();
		await seedBody(db, {
			name: "Zebra Board",
			slug: "zebra-board",
			type: "county",
		});
		await seedBody(db, {
			name: "Alpha Council",
			slug: "alpha-council",
			type: "town",
		});

		const result = await listBodiesWithStatsQuery(db);

		expect(result[0].name).toBe("Alpha Council");
		expect(result[1].name).toBe("Zebra Board");
	});

	it("returns empty array when no bodies exist", async () => {
		const db = await createTestDb();
		expect(await listBodiesWithStatsQuery(db)).toEqual([]);
	});
});

describe("getBodyWithStatsBySlugQuery", () => {
	it("returns stats scoped to one body", async () => {
		const db = await createTestDb();
		const town = await seedBody(db);
		const other = await seedBody(db, {
			name: "Other Body",
			slug: "other-body",
			type: "county",
		});

		await seedMeetingWithSummary(db, town.id, "2026-01-15", {
			fiscalDecisions: [{ title: "A", amount: 1000, originalAmount: "$1,000" }],
		});
		await seedMeetingWithSummary(db, other.id, "2026-02-15", {
			fiscalDecisions: [{ title: "B", amount: 9999, originalAmount: "$9,999" }],
		});

		const result = await getBodyWithStatsBySlugQuery(db, town.slug);

		expect(result).toMatchObject({
			slug: town.slug,
			meetingCount: 1,
			decisionCount: 1,
			totalSpending: 1000,
		});
	});

	it("returns null for an unknown slug", async () => {
		const db = await createTestDb();
		await seedBody(db);
		expect(await getBodyWithStatsBySlugQuery(db, "no-such-body")).toBeNull();
	});

	it("returns zeros for a body with no meetings", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);

		const result = await getBodyWithStatsBySlugQuery(db, body.slug);

		expect(result).toMatchObject({
			slug: body.slug,
			meetingCount: 0,
			decisionCount: 0,
			totalSpending: 0,
		});
	});
});

describe("aggregateFiscalByCategoryForBodyQuery", () => {
	it("aggregates only the specified body's decisions", async () => {
		const db = await createTestDb();
		const town = await seedBody(db);
		const other = await seedBody(db, {
			name: "Other",
			slug: "other",
			type: "county",
		});

		await seedMeetingWithSummary(db, town.id, "2026-01-15", {
			fiscalDecisions: [
				{
					title: "Road",
					amount: 100000,
					originalAmount: "$100,000",
					budgetCategory: "infrastructure",
				},
				{
					title: "Bridge",
					amount: 200000,
					originalAmount: "$200,000",
					budgetCategory: "infrastructure",
				},
				{
					title: "Library",
					amount: 50000,
					originalAmount: "$50,000",
					budgetCategory: "education",
				},
			],
		});
		await seedMeetingWithSummary(db, other.id, "2026-02-15", {
			fiscalDecisions: [
				{
					title: "Should not count",
					amount: 999999,
					originalAmount: "$999,999",
					budgetCategory: "infrastructure",
				},
			],
		});

		const result = await aggregateFiscalByCategoryForBodyQuery(db, town.slug);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			budgetCategory: "infrastructure",
			totalAmount: 300000,
			decisionCount: 2,
		});
		expect(result[1]).toMatchObject({
			budgetCategory: "education",
			totalAmount: 50000,
			decisionCount: 1,
		});
	});

	it("groups null budgetCategory under 'Uncategorized'", async () => {
		const db = await createTestDb();
		const body = await seedBody(db);
		await seedMeetingWithSummary(db, body.id, "2026-01-15", {
			fiscalDecisions: [
				{ title: "Untagged", amount: 500, originalAmount: "$500" },
			],
		});

		const result = await aggregateFiscalByCategoryForBodyQuery(db, body.slug);

		expect(result[0]).toMatchObject({
			budgetCategory: "Uncategorized",
			totalAmount: 500,
			decisionCount: 1,
		});
	});

	it("returns empty array for an unknown slug", async () => {
		const db = await createTestDb();
		await seedBody(db);
		expect(
			await aggregateFiscalByCategoryForBodyQuery(db, "no-such-body"),
		).toEqual([]);
	});
});
