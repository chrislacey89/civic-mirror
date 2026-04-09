// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingPage } from "./index.tsx";

afterEach(cleanup);

const emptyData = {
	meetings: [],
	bodies: [],
	fiscalByBody: [],
	fiscalByCategory: [],
	fiscalByTimePeriod: [],
	notableDecisions: [],
};

const populatedData = {
	meetings: [
		{
			id: 1,
			date: "2026-03-23",
			meetingType: "regular" as const,
			bodyName: "Ellettsville Town Council",
			bodySlug: "ellettsville-town-council",
			highlights: ["Approved road repairs"],
			prose: "Council met to discuss infrastructure.",
			fiscalDecisionCount: 1,
			totalSpending: 50000,
		},
	],
	bodies: [
		{
			name: "Ellettsville Town Council",
			slug: "ellettsville-town-council",
			type: "town",
		},
	],
	fiscalByBody: [
		{
			bodyName: "Ellettsville Town Council",
			bodySlug: "ellettsville-town-council",
			totalAmount: 50000,
			decisionCount: 1,
		},
	],
	fiscalByCategory: [
		{ budgetCategory: "infrastructure", totalAmount: 50000, decisionCount: 1 },
	],
	fiscalByTimePeriod: [
		{ period: "2026-03", totalAmount: 50000, decisionCount: 1 },
	],
	notableDecisions: [
		{
			title: "Sale Street Road Repairs",
			amount: 50000,
			status: "approved" as const,
			bodyName: "Ellettsville Town Council",
			bodySlug: "ellettsville-town-council",
			date: "2026-03-23",
		},
	],
};

describe("LandingPage", () => {
	it("renders hero section with site title", () => {
		render(<LandingPage data={emptyData} />);

		expect(screen.getByText("Civic Mirror")).toBeDefined();
	});

	it("shows empty state when no meetings exist", () => {
		render(<LandingPage data={emptyData} />);

		expect(screen.getByText(/no meetings/i)).toBeDefined();
	});

	it("renders meeting cards when meetings exist", () => {
		render(<LandingPage data={populatedData} />);

		expect(screen.getByText("March 23, 2026")).toBeDefined();
	});

	it("renders fiscal summary section", () => {
		render(<LandingPage data={populatedData} />);

		expect(screen.getByText("Fiscal Overview")).toBeDefined();
	});

	it("renders body filter options", () => {
		render(<LandingPage data={populatedData} />);

		const select = screen.getByRole("combobox");
		expect(select).toBeDefined();
	});
});
