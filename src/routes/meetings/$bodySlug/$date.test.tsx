// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MeetingDetail } from "#/db/queries.ts";
import { MeetingDetailView } from "./$date.tsx";

afterEach(cleanup);

function makeMeeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
	return {
		id: 1,
		date: "2026-03-23",
		session: "",
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
		summarySources: { origin: "documents" },
		sourceDisagreements: [],
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

describe("MeetingDetailView — summary sources", () => {
	const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";

	it("says a summary with both kinds was built from the video and the documents, and links to both", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					summarySources: {
						origin: "both",
						videoUrl: VIDEO_URL,
					},
				})}
			/>,
		);

		expect(
			screen.getByText(
				"This summary was built from the meeting video and the official documents.",
			),
		).toBeDefined();
		expect(
			screen
				.getByRole("link", { name: /Watch the meeting video/ })
				.getAttribute("href"),
		).toBe(VIDEO_URL);
		expect(
			screen
				.getByRole("link", { name: /View minutes PDF/ })
				.getAttribute("href"),
		).toBe("https://example.gov/minutes.pdf");
	});

	it("says a documents-only summary was built from the official documents, with no video link or notice", () => {
		render(<MeetingDetailView meeting={makeMeeting()} />);

		expect(
			screen.getByText("This summary was built from the official documents."),
		).toBeDefined();
		expect(
			screen.getByRole("link", { name: /View minutes PDF/ }),
		).toBeDefined();
		expect(screen.queryByRole("link", { name: /video/i })).toBeNull();
		expect(screen.queryByText(/video alone/)).toBeNull();
		expect(screen.getByText("Key Highlights")).toBeDefined();
	});

	it("tells the reader a video-only summary came from the video alone and that minutes are not yet posted", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					documents: [],
					summarySources: { origin: "video", videoUrl: VIDEO_URL },
				})}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain(
			"This summary was built from the meeting video alone. Official minutes are not yet posted.",
		);
		expect(
			screen
				.getByRole("link", { name: /Watch the meeting video/ })
				.getAttribute("href"),
		).toBe(VIDEO_URL);
		expect(screen.getByText("Key Highlights")).toBeDefined();
		expect(screen.getByText("Sale Street Road Repairs")).toBeDefined();
		expect(screen.queryByText(/couldn't extract readable text/)).toBeNull();
	});

	it("does not claim minutes are unposted when a document is attached to a video-only summary", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					summarySources: { origin: "video", videoUrl: VIDEO_URL },
				})}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain(
			"This summary was built from the meeting video alone.",
		);
		expect(screen.queryByText(/not yet posted/)).toBeNull();
		expect(
			screen.getByRole("link", { name: /View minutes PDF/ }),
		).toBeDefined();
	});

	it("lists each disagreement with what the documents and the video say, and says the summary uses the documents' figure", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					summarySources: {
						origin: "both",
						videoUrl: VIDEO_URL,
					},
					sourceDisagreements: [
						{
							topic: "Paving bid",
							documentsSay: "$215,215.10",
							transcriptSays: "$244,215.10",
						},
						{
							topic: "Wheel tax vote",
							documentsSay: "Passed 4–1",
							transcriptSays: "Passed 5–0",
						},
					],
				})}
			/>,
		);

		const section = screen.getByRole("region", {
			name: "Where the video and the documents differ",
		});
		expect(section.textContent).toContain(
			"The summary uses the documents' figure.",
		);
		const items = within(section).getAllByRole("listitem");
		expect(items.map((item) => item.textContent)).toEqual([
			"Paving bidThe documents say: $215,215.10The video says: $244,215.10",
			"Wheel tax voteThe documents say: Passed 4–1The video says: Passed 5–0",
		]);
	});

	it("renders no disagreement section when the sources do not disagree", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					summarySources: {
						origin: "both",
						videoUrl: VIDEO_URL,
					},
				})}
			/>,
		);

		expect(screen.queryByText(/differ/)).toBeNull();
		expect(screen.queryByText(/documents' figure/)).toBeNull();
	});
});
