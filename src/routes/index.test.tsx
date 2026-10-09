// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingPage } from "./index.tsx";

afterEach(cleanup);

type LandingData = Parameters<typeof LandingPage>[0]["data"];

/** Renders the page inside a router so its `<Link>`s resolve to real hrefs. */
async function renderPage(data: LandingData) {
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => <LandingPage data={data} />,
		}),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const result = render(<RouterProvider router={router} />);
	await screen.findByRole("heading", { level: 1 });
	return { router, ...result };
}

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
			session: "",
			meetingType: "regular" as const,
			bodyName: "Ellettsville Town Council",
			bodySlug: "ellettsville-town-council",
			extractionMethod: "text-layer" as const,
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
			session: "",
		},
	],
};

describe("LandingPage", () => {
	it("renders hero section with site title", async () => {
		await renderPage(emptyData);

		screen.getByText("Civic Mirror");
	});

	it("shows empty state when no meetings exist", async () => {
		await renderPage(emptyData);

		screen.getByText(/no meetings/i);
	});

	it("renders meeting cards when meetings exist", async () => {
		await renderPage(populatedData);

		screen.getByText("March 23, 2026");
	});

	it("links the lead headline and a read-more line to the lead meeting", async () => {
		await renderPage(populatedData);

		const href = "/meetings/ellettsville-town-council/2026-03-23";
		const headline = screen.getByRole("heading", { level: 1 });
		expect(headline.querySelector("a")?.getAttribute("href")).toBe(href);
		expect(
			screen
				.getByRole("link", { name: /read the full summary/i })
				.getAttribute("href"),
		).toBe(href);
	});

	it("keeps a digits-only session a string through the router", async () => {
		const [meeting] = populatedData.meetings;
		const { router } = await renderPage({
			...populatedData,
			meetings: [{ ...meeting, session: "2026" }],
		});

		const href = screen
			.getByRole("link", { name: /read the full summary/i })
			.getAttribute("href");
		expect(href).toBe(
			"/meetings/ellettsville-town-council/2026-03-23?session=%222026%22",
		);
		const search = router.options.parseSearch(`?${href?.split("?")[1]}`);
		expect(search.session).toBe("2026");
		// A hand-built `?session=2026` is parsed to a number, which the meeting
		// page's validateSearch drops.
		expect(router.options.parseSearch("?session=2026").session).toBe(2026);
	});

	it("shows only the first sentence of the lead meeting prose as the lede", async () => {
		const first = "Council accepts $212,400 bid to repave Maple Street.";
		const second = "The work starts in June.";
		const [meeting] = populatedData.meetings;
		const data = {
			...populatedData,
			meetings: [{ ...meeting, prose: `${first} ${second}` }],
		};

		const { container } = await renderPage(data);

		const lede = container.querySelector(".lede");
		expect(lede?.textContent).toBe(first);
		expect(screen.queryByText(second, { exact: false })).toBeNull();
	});

	it("renders fiscal summary section", async () => {
		await renderPage(populatedData);

		screen.getByText("Fiscal Overview");
	});

	it("renders body filter options", async () => {
		await renderPage(populatedData);

		screen.getByRole("combobox");
	});
});
