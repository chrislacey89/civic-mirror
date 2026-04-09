// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, it } from "vitest";
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
			type: "town" as const,
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

		screen.getByText("Civic Mirror");
	});

	it("shows empty state when no meetings exist", () => {
		render(<LandingPage data={emptyData} />);

		screen.getByText(/no meetings/i);
	});

	it("renders meeting cards when meetings exist", () => {
		render(<LandingPage data={populatedData} />);

		screen.getByText("March 23, 2026");
	});

	it("renders fiscal summary section", () => {
		render(<LandingPage data={populatedData} />);

		screen.getByText("Fiscal Overview");
	});

	it("renders body filter options", () => {
		render(<LandingPage data={populatedData} />);

		screen.getByRole("combobox");
	});
});
