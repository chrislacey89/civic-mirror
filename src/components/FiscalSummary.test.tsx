// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FiscalSummary } from "./FiscalSummary.tsx";

afterEach(cleanup);

const sampleProps = {
	byBody: [
		{
			bodyName: "Ellettsville Town Council",
			bodySlug: "ellettsville-town-council",
			totalAmount: 75000,
			decisionCount: 3,
		},
		{
			bodyName: "RBBSC School Board",
			bodySlug: "rbbsc-school-board",
			totalAmount: 30000,
			decisionCount: 2,
		},
	],
	byCategory: [
		{ budgetCategory: "infrastructure", totalAmount: 50000, decisionCount: 2 },
		{ budgetCategory: "education", totalAmount: 30000, decisionCount: 1 },
	],
	byTimePeriod: [
		{ period: "2026-03", totalAmount: 65000, decisionCount: 3 },
		{ period: "2026-02", totalAmount: 40000, decisionCount: 2 },
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

describe("FiscalSummary", () => {
	it("renders spending by body totals", () => {
		render(<FiscalSummary {...sampleProps} />);

		screen.getByText("Spending by Body");
		screen.getByText("$75,000");
		expect(
			screen.getAllByText("Ellettsville Town Council").length,
		).toBeGreaterThanOrEqual(1);
		screen.getByText("RBBSC School Board");
	});

	it("renders spending by category", () => {
		render(<FiscalSummary {...sampleProps} />);

		screen.getByText("Spending by Category");
		screen.getByText("infrastructure");
		screen.getByText("education");
	});

	it("renders spending by time period", () => {
		render(<FiscalSummary {...sampleProps} />);

		screen.getByText("2026-03");
		screen.getByText("$65,000");
	});

	it("renders notable fiscal decisions", () => {
		render(<FiscalSummary {...sampleProps} />);

		screen.getByText("Sale Street Road Repairs");
	});

	it("shows empty state when no fiscal data", () => {
		render(
			<FiscalSummary
				byBody={[]}
				byCategory={[]}
				byTimePeriod={[]}
				notableDecisions={[]}
			/>,
		);

		screen.getByText(/no fiscal data/i);
	});
});
