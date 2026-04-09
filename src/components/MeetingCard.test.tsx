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
	highlights: ["Approved road repairs", "Discussed park budget"],
	prose: "The council met to discuss infrastructure spending.",
	fiscalDecisionCount: 2,
	totalSpending: 75000,
};

describe("MeetingCard", () => {
	it("renders body name and formatted date", () => {
		render(<MeetingCard meeting={baseMeeting} />);

		expect(screen.getByText("Ellettsville Town Council")).toBeDefined();
		expect(screen.getByText("March 23, 2026")).toBeDefined();
	});

	it("renders highlights as a list", () => {
		render(<MeetingCard meeting={baseMeeting} />);

		expect(screen.getByText("Approved road repairs")).toBeDefined();
		expect(screen.getByText("Discussed park budget")).toBeDefined();
	});

	it("renders fiscal decision count and total spending", () => {
		render(<MeetingCard meeting={baseMeeting} />);

		expect(screen.getByText("$75,000")).toBeDefined();
		expect(screen.getByText(/2 decisions/i)).toBeDefined();
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
});
