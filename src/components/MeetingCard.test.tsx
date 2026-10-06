// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MeetingCard } from "./MeetingCard.tsx";

afterEach(cleanup);

const baseMeeting = {
	id: 1,
	date: "2026-03-23",
	meetingType: "regular" as const,
	bodyName: "Ellettsville Town Council",
	bodySlug: "ellettsville-town-council",
	extractionMethod: "text-layer" as const,
	highlights: ["Approved road repairs", "Discussed park budget"],
	prose: "The council met to discuss infrastructure spending.",
	fiscalDecisionCount: 2,
	totalSpending: 75000,
};

describe("MeetingCard", () => {
	it("renders body name and formatted date", () => {
		render(<MeetingCard meeting={baseMeeting} />);

		screen.getByText("Ellettsville Town Council");
		screen.getByText("March 23, 2026");
	});

	it("renders highlights as a list", () => {
		render(<MeetingCard meeting={baseMeeting} />);

		screen.getByText("Approved road repairs");
		screen.getByText("Discussed park budget");
	});

	it("renders fiscal decision count and total spending", () => {
		render(<MeetingCard meeting={baseMeeting} />);

		screen.getByText("$75,000");
		screen.getByText(/2 decisions/i);
	});

	it("links to the meeting detail page", () => {
		render(<MeetingCard meeting={baseMeeting} />);

		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe(
			"/meetings/ellettsville-town-council/2026-03-23",
		);
	});

	it("hides fiscal section when no spending", () => {
		render(
			<MeetingCard
				meeting={{ ...baseMeeting, fiscalDecisionCount: 0, totalSpending: 0 }}
			/>,
		);

		expect(screen.queryByText(/decisions/i)).toBeNull();
	});

	it("renders an unreadable variant without highlights or fiscal rollup", () => {
		render(
			<MeetingCard
				meeting={{
					...baseMeeting,
					extractionMethod: "unreadable",
					highlights: [],
					prose: "",
					fiscalDecisionCount: 0,
					totalSpending: 0,
				}}
			/>,
		);

		// Body + date still shown; link still navigates to detail
		screen.getByText("Ellettsville Town Council");
		screen.getByText("March 23, 2026");
		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe(
			"/meetings/ellettsville-town-council/2026-03-23",
		);

		// Muted explanatory note directing to source PDF
		expect(
			screen.getByText(
				/Source document couldn't be extracted — open to view the original PDF\./,
			),
		).toBeDefined();

		// No fiscal rollup, no highlight bullets
		expect(screen.queryByText(/decisions/i)).toBeNull();
		expect(screen.queryByRole("list")).toBeNull();
	});
});
