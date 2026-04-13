// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MeetingDetail } from "#/db/queries.ts";
import { MeetingDetailView } from "./$date.tsx";

afterEach(cleanup);

function makeMeeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
	return {
		id: 1,
		date: "2026-03-23",
		meetingType: "regular",
		bodyName: "Ellettsville Town Council",
		bodySlug: "ellettsville-town-council",
		extractionMethod: "text-layer",
		documents: [
			{
				sourceUrl: "https://example.gov/minutes.pdf",
				rawText: "Text content.",
				documentType: "minutes",
				extractionMethod: "text-layer",
			},
		],
		summary: {
			highlights: ["Approved road repairs"],
			prose: "Council discussed infrastructure.",
			model: "gemini-2.5-flash",
		},
		fiscalDecisions: [
			{
				title: "Sale Street Road Repairs",
				description: "Funding for road repairs",
				amount: 50000,
				originalAmount: "$50,000",
				budgetCategory: "infrastructure",
				status: "approved",
				voteRecord: null,
				vendor: null,
				fundingSource: null,
				ordinanceNumber: null,
				confidence: 0.95,
				isRecurring: false,
			},
		],
		budgetDiscussions: [],
		...overrides,
	};
}

describe("MeetingDetailView — text-layer branch", () => {
	it("renders highlights, summary, and fiscal decisions without OCR banner", () => {
		render(<MeetingDetailView meeting={makeMeeting()} />);

		expect(screen.getByText("Key Highlights")).toBeDefined();
		expect(screen.getByText("Summary")).toBeDefined();
		expect(screen.getByText("Sale Street Road Repairs")).toBeDefined();
		expect(screen.queryByText(/Extracted via OCR/i)).toBeNull();
		expect(
			screen.queryByLabelText("OCR-extracted figure, verify against source"),
		).toBeNull();
	});
});

describe("MeetingDetailView — ocr branch", () => {
	it("renders the OCR banner with role=status above the summary", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					extractionMethod: "ocr",
					documents: [
						{
							sourceUrl: "https://example.gov/minutes.pdf",
							rawText: "OCR text.",
							documentType: "minutes",
							extractionMethod: "ocr",
						},
					],
				})}
			/>,
		);

		const banner = screen.getByText(
			/Extracted via OCR from a scanned PDF\. Verify figures against the original document\./,
		);
		expect(banner).toBeDefined();
		// Banner must be role=status (polite), not role=alert
		const statusRegion = screen.getByRole("status");
		expect(statusRegion.textContent).toMatch(/Extracted via OCR/);
	});

	it("marks every fiscal figure with a ? superscript and correct aria-label", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					extractionMethod: "ocr",
					documents: [
						{
							sourceUrl: "https://example.gov/minutes.pdf",
							rawText: "OCR text.",
							documentType: "minutes",
							extractionMethod: "ocr",
						},
					],
					fiscalDecisions: [
						{
							title: "A",
							description: "d",
							amount: 1000,
							originalAmount: "$1,000",
							budgetCategory: null,
							status: "approved",
							voteRecord: null,
							vendor: null,
							fundingSource: null,
							ordinanceNumber: null,
							confidence: 0.7,
							isRecurring: false,
						},
						{
							title: "B",
							description: "d",
							amount: 2000,
							originalAmount: "$2,000",
							budgetCategory: null,
							status: "approved",
							voteRecord: null,
							vendor: null,
							fundingSource: null,
							ordinanceNumber: null,
							confidence: 0.7,
							isRecurring: false,
						},
					],
				})}
			/>,
		);

		const badges = screen.getAllByLabelText(
			"OCR-extracted figure, verify against source",
		);
		expect(badges).toHaveLength(2);
		for (const badge of badges) {
			expect(badge.textContent).toBe("?");
		}
	});
});

describe("MeetingDetailView — unreadable branch", () => {
	it("renders a single status card with copy and hides all content sections", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					extractionMethod: "unreadable",
					documents: [
						{
							sourceUrl: "https://example.gov/scan.pdf",
							rawText: "",
							documentType: "minutes",
							extractionMethod: "unreadable",
						},
					],
					summary: null,
					fiscalDecisions: [],
					budgetDiscussions: [],
				})}
			/>,
		);

		// Status card copy (DATE and BODY interpolated)
		const statusRegion = screen.getByRole("status");
		expect(statusRegion.textContent).toMatch(
			/We couldn't extract readable text from this .+ Ellettsville Town Council meeting\. The original document is available below\./,
		);

		// Content sections hidden entirely
		expect(screen.queryByText("Key Highlights")).toBeNull();
		expect(screen.queryByText("Summary")).toBeNull();
		expect(screen.queryByText("Fiscal Decisions")).toBeNull();
		expect(screen.queryByText(/Budget Discussions/)).toBeNull();

		// Source PDF link still present
		expect(screen.getByText(/View minutes PDF/)).toBeDefined();
	});
});
