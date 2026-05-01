import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { describe, expect, it } from "vitest";
import {
	aggregateFiscalByBodyQuery,
	aggregateFiscalByCategoryQuery,
	aggregateFiscalByTimePeriodQuery,
	listGoverningBodiesQuery,
	listNotableFiscalDecisionsQuery,
	listRecentMeetingsQuery,
} from "#/db/queries.ts";
import * as schema from "#/db/schema.ts";

/**
 * Server functions are thin wrappers over query functions.
 * These tests verify the query functions are correctly integrated
 * with a seeded database — the server function RPC wiring is
 * tested via TanStack Start's integration layer.
 */

async function createTestDb() {
	const client = createClient({ url: ":memory:" });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: "./drizzle" });
	return db;
}

async function seedFullScenario(db: Awaited<ReturnType<typeof createTestDb>>) {
	const council = await db
		.insert(schema.governingBodies)
		.values({
			name: "Ellettsville Town Council",
			slug: "ellettsville-town-council",
			type: "town",
		})
		.returning()
		.get();

	const school = await db
		.insert(schema.governingBodies)
		.values({
			name: "RBBSC School Board",
			slug: "rbbsc-school-board",
			type: "school",
		})
		.returning()
		.get();

	// Council meeting with fiscal decisions
	const m1 = await db
		.insert(schema.meetings)
		.values({ bodyId: council.id, date: "2026-03-23", meetingType: "regular" })
		.returning()
		.get();

	await db
		.insert(schema.summaries)
		.values({
			meetingId: m1.id,
			highlights: ["Approved road repairs", "Discussed park budget"],
			prose: "Town Council met to discuss infrastructure.",
			model: "gemini-2.5-flash",
		})
		.run();

	await db
		.insert(schema.fiscalDecisions)
		.values({
			meetingId: m1.id,
			title: "Sale Street Road Repairs",
			description: "Funding for road repairs",
			amount: 50000,
			originalAmount: "$50,000",
			budgetCategory: "infrastructure",
			status: "approved",
			confidence: 0.95,
			isRecurring: false,
		})
		.run();

	// School board meeting
	const m2 = await db
		.insert(schema.meetings)
		.values({ bodyId: school.id, date: "2026-03-20", meetingType: "regular" })
		.returning()
		.get();

	await db
		.insert(schema.summaries)
		.values({
			meetingId: m2.id,
			highlights: ["New textbook budget approved"],
			prose: "School board approved textbook purchases.",
			model: "gemini-2.5-flash",
		})
		.run();

	await db
		.insert(schema.fiscalDecisions)
		.values({
			meetingId: m2.id,
			title: "Textbook Purchase",
			description: "Annual textbook order",
			amount: 15000,
			originalAmount: "$15,000",
			budgetCategory: "education",
			status: "approved",
			confidence: 0.9,
			isRecurring: true,
		})
		.run();

	return { council, school, m1, m2 };
}

describe("server function integration", () => {
	it("listRecentMeetings returns all meetings with fiscal rollups", async () => {
		const db = await createTestDb();
		await seedFullScenario(db);

		const result = await listRecentMeetingsQuery(db);

		expect(result).toHaveLength(2);
		expect(result[0].date).toBe("2026-03-23");
		expect(result[0].totalSpending).toBe(50000);
		expect(result[1].date).toBe("2026-03-20");
		expect(result[1].totalSpending).toBe(15000);
	});

	it("listRecentMeetings filters by body slug", async () => {
		const db = await createTestDb();
		await seedFullScenario(db);

		const result = await listRecentMeetingsQuery(db, "rbbsc-school-board");

		expect(result).toHaveLength(1);
		expect(result[0].bodyName).toBe("RBBSC School Board");
	});

	it("aggregateFiscalByBody returns correct totals per body", async () => {
		const db = await createTestDb();
		await seedFullScenario(db);

		const result = await aggregateFiscalByBodyQuery(db);

		expect(result).toHaveLength(2);
		const council = result.find(
			(r) => r.bodySlug === "ellettsville-town-council",
		);
		expect(council?.totalAmount).toBe(50000);
	});

	it("aggregateFiscalByCategory returns correct totals per category", async () => {
		const db = await createTestDb();
		await seedFullScenario(db);

		const result = await aggregateFiscalByCategoryQuery(db);

		const infra = result.find((r) => r.budgetCategory === "infrastructure");
		const edu = result.find((r) => r.budgetCategory === "education");
		expect(infra?.totalAmount).toBe(50000);
		expect(edu?.totalAmount).toBe(15000);
	});

	it("aggregateFiscalByTimePeriod groups by month", async () => {
		const db = await createTestDb();
		await seedFullScenario(db);

		const result = await aggregateFiscalByTimePeriodQuery(db);

		expect(result).toHaveLength(1); // both in 2026-03
		expect(result[0].period).toBe("2026-03");
		expect(result[0].totalAmount).toBe(65000);
	});

	it("listNotableFiscalDecisions returns highest amounts first", async () => {
		const db = await createTestDb();
		await seedFullScenario(db);

		const result = await listNotableFiscalDecisionsQuery(db);

		expect(result[0].title).toBe("Sale Street Road Repairs");
		expect(result[0].amount).toBe(50000);
		expect(result[1].title).toBe("Textbook Purchase");
	});

	it("listGoverningBodies returns all bodies alphabetically", async () => {
		const db = await createTestDb();
		await seedFullScenario(db);

		const result = await listGoverningBodiesQuery(db);

		expect(result).toHaveLength(2);
		expect(result[0].name).toBe("Ellettsville Town Council");
		expect(result[1].name).toBe("RBBSC School Board");
	});
});
