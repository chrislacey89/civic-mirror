import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "#/db/schema.ts";
import {
	aggregateFiscalByBodyQuery,
	aggregateFiscalByCategoryQuery,
	aggregateFiscalByTimePeriodQuery,
	listGoverningBodiesQuery,
	listNotableFiscalDecisionsQuery,
	listRecentMeetingsQuery,
} from "./queries.ts";

function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return db;
}

function seedBody(
	db: ReturnType<typeof createTestDb>,
	overrides: Partial<typeof schema.governingBodies.$inferInsert> = {},
) {
	return db
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

function seedMeetingWithSummary(
	db: ReturnType<typeof createTestDb>,
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
	const meeting = db
		.insert(schema.meetings)
		.values({ bodyId, date, meetingType: "regular" })
		.returning()
		.get();

	db.insert(schema.summaries)
		.values({
			meetingId: meeting.id,
			highlights: opts.highlights ?? ["Highlight one"],
			prose: opts.prose ?? "Summary prose.",
			model: "gemini-2.5-flash",
		})
		.run();

	for (const fd of opts.fiscalDecisions ?? []) {
		db.insert(schema.fiscalDecisions)
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
	it("returns meetings ordered by date descending", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-01-15");
		seedMeetingWithSummary(db, body.id, "2026-03-23");
		seedMeetingWithSummary(db, body.id, "2026-02-10");

		const result = listRecentMeetingsQuery(db);

		expect(result).toHaveLength(3);
		expect(result[0].date).toBe("2026-03-23");
		expect(result[1].date).toBe("2026-02-10");
		expect(result[2].date).toBe("2026-01-15");
	});

	it("filters by body slug when provided", () => {
		const db = createTestDb();
		const council = seedBody(db);
		const school = seedBody(db, {
			name: "RBBSC School Board",
			slug: "rbbsc-school-board",
			type: "school",
		});
		seedMeetingWithSummary(db, council.id, "2026-03-23");
		seedMeetingWithSummary(db, school.id, "2026-03-20");
		seedMeetingWithSummary(db, council.id, "2026-02-10");

		const result = listRecentMeetingsQuery(db, "rbbsc-school-board");

		expect(result).toHaveLength(1);
		expect(result[0].bodySlug).toBe("rbbsc-school-board");
	});

	it("returns empty array for unknown body slug", () => {
		const db = createTestDb();
		seedBody(db);

		const result = listRecentMeetingsQuery(db, "nonexistent-body");

		expect(result).toHaveLength(0);
	});

	it("skips meetings without summaries", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-03-23");
		// Insert a meeting with no summary
		db.insert(schema.meetings)
			.values({ bodyId: body.id, date: "2026-04-01", meetingType: "regular" })
			.run();

		const result = listRecentMeetingsQuery(db);

		expect(result).toHaveLength(1);
		expect(result[0].date).toBe("2026-03-23");
	});

	it("includes fiscal decision count and total spending", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-03-23", {
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

		const result = listRecentMeetingsQuery(db);

		expect(result[0].fiscalDecisionCount).toBe(2);
		expect(result[0].totalSpending).toBe(75000);
	});

	it("returns empty array when no meetings exist", () => {
		const db = createTestDb();

		const result = listRecentMeetingsQuery(db);

		expect(result).toHaveLength(0);
	});
});

describe("aggregateFiscalByBodyQuery", () => {
	it("sums spending by governing body", () => {
		const db = createTestDb();
		const council = seedBody(db);
		const school = seedBody(db, {
			name: "RBBSC School Board",
			slug: "rbbsc-school-board",
			type: "school",
		});
		seedMeetingWithSummary(db, council.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Roads", amount: 50000, originalAmount: "$50,000" },
			],
		});
		seedMeetingWithSummary(db, school.id, "2026-03-20", {
			fiscalDecisions: [
				{ title: "Books", amount: 10000, originalAmount: "$10,000" },
				{ title: "Computers", amount: 20000, originalAmount: "$20,000" },
			],
		});

		const result = aggregateFiscalByBodyQuery(db);

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

	it("returns empty array when no fiscal decisions exist", () => {
		const db = createTestDb();

		const result = aggregateFiscalByBodyQuery(db);

		expect(result).toHaveLength(0);
	});
});

describe("aggregateFiscalByCategoryQuery", () => {
	it("sums spending by budget category", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-03-23", {
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

		const result = aggregateFiscalByCategoryQuery(db);

		const infra = result.find((r) => r.budgetCategory === "infrastructure");
		const parks = result.find((r) => r.budgetCategory === "parks");
		expect(infra?.totalAmount).toBe(80000);
		expect(infra?.decisionCount).toBe(2);
		expect(parks?.totalAmount).toBe(25000);
		expect(parks?.decisionCount).toBe(1);
	});

	it("labels null categories as Uncategorized", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Misc", amount: 5000, originalAmount: "$5,000" },
			],
		});

		const result = aggregateFiscalByCategoryQuery(db);

		expect(result[0].budgetCategory).toBe("Uncategorized");
	});
});

describe("aggregateFiscalByTimePeriodQuery", () => {
	it("sums spending by month ordered newest first", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-01-15", {
			fiscalDecisions: [
				{ title: "Jan item", amount: 10000, originalAmount: "$10,000" },
			],
		});
		seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Mar item 1", amount: 50000, originalAmount: "$50,000" },
				{ title: "Mar item 2", amount: 20000, originalAmount: "$20,000" },
			],
		});

		const result = aggregateFiscalByTimePeriodQuery(db);

		expect(result).toHaveLength(2);
		expect(result[0].period).toBe("2026-03");
		expect(result[0].totalAmount).toBe(70000);
		expect(result[1].period).toBe("2026-01");
		expect(result[1].totalAmount).toBe(10000);
	});
});

describe("listNotableFiscalDecisionsQuery", () => {
	it("returns decisions ordered by amount descending", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Small", amount: 5000, originalAmount: "$5,000" },
				{ title: "Big", amount: 100000, originalAmount: "$100,000" },
				{ title: "Medium", amount: 30000, originalAmount: "$30,000" },
			],
		});

		const result = listNotableFiscalDecisionsQuery(db);

		expect(result[0].title).toBe("Big");
		expect(result[0].amount).toBe(100000);
		expect(result[1].title).toBe("Medium");
		expect(result[2].title).toBe("Small");
	});

	it("includes body name and meeting date", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "Item", amount: 50000, originalAmount: "$50,000" },
			],
		});

		const result = listNotableFiscalDecisionsQuery(db);

		expect(result[0].bodyName).toBe("Ellettsville Town Council");
		expect(result[0].date).toBe("2026-03-23");
	});

	it("respects limit parameter", () => {
		const db = createTestDb();
		const body = seedBody(db);
		seedMeetingWithSummary(db, body.id, "2026-03-23", {
			fiscalDecisions: [
				{ title: "A", amount: 1000, originalAmount: "$1,000" },
				{ title: "B", amount: 2000, originalAmount: "$2,000" },
				{ title: "C", amount: 3000, originalAmount: "$3,000" },
			],
		});

		const result = listNotableFiscalDecisionsQuery(db, 2);

		expect(result).toHaveLength(2);
	});
});

describe("listGoverningBodiesQuery", () => {
	it("returns all bodies ordered by name", () => {
		const db = createTestDb();
		seedBody(db, { name: "Zebra Board", slug: "zebra-board", type: "county" });
		seedBody(db, {
			name: "Alpha Council",
			slug: "alpha-council",
			type: "town",
		});

		const result = listGoverningBodiesQuery(db);

		expect(result).toHaveLength(2);
		expect(result[0].name).toBe("Alpha Council");
		expect(result[1].name).toBe("Zebra Board");
	});
});
