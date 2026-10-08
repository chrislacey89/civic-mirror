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

describe("MeetingDetailView — decisions with no stated amount", () => {
	const base = makeMeeting().fiscalDecisions[0];
	const noAmount = {
		...base,
		title: "Fire Services Agreement",
		amount: 0,
		originalAmount: "not stated",
	};

	it("shows a decision with no amount as not stated, and never as $0", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({ fiscalDecisions: [base, noAmount] })}
			/>,
		);

		const row = screen.getByText("Fire Services Agreement").closest("div")
			?.parentElement as HTMLElement;
		expect(within(row).getByText("Not stated")).toBeDefined();
		expect(screen.queryByText("$0")).toBeNull();
	});

	it("counts beside the total only the decisions that state an amount", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({ fiscalDecisions: [base, noAmount] })}
			/>,
		);

		expect(screen.getByText("1 of 2")).toBeDefined();
		expect(screen.getByText("Decisions with an amount")).toBeDefined();
	});

	it("gives the plain count when every decision states an amount", () => {
		render(<MeetingDetailView meeting={makeMeeting()} />);

		expect(screen.getByText("Fiscal decisions")).toBeDefined();
		expect(screen.queryByText("Decisions with an amount")).toBeNull();
	});

	it("leaves out the estimate of a discussion that has none", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					budgetDiscussions: [
						{ topic: "Salary ordinance", estimatedAmount: 0, notes: null },
					],
				})}
			/>,
		);

		expect(screen.getByText("Salary ordinance")).toBeDefined();
		expect(screen.queryByText(/Estimated/)).toBeNull();
	});
});

describe("MeetingDetailView — headline total", () => {
	const base = makeMeeting().fiscalDecisions[0];

	it("counts only approved decisions as approved this meeting, matching the table's total", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					fiscalDecisions: [
						base,
						{
							...base,
							title: "Roof replacement bids",
							amount: 209563.79,
							originalAmount: "$209,563.79",
							status: "tabled",
						},
						{
							...base,
							title: "Sign purchase",
							amount: 1200,
							originalAmount: "$1,200",
							status: "denied",
						},
					],
				})}
			/>,
		);

		const headline = screen.getByText("Approved this meeting")
			.parentElement as HTMLElement;
		const footer = screen.getByText("Total approved, this meeting")
			.parentElement as HTMLElement;
		expect(within(headline).getByText("$50,000")).toBeDefined();
		expect(within(footer).getByText("$50,000")).toBeDefined();
	});
});

describe("MeetingDetailView — resolution and ordinance numbers", () => {
	const base = makeMeeting().fiscalDecisions[0];

	it("shows a number that carries its type as written", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					fiscalDecisions: [{ ...base, ordinanceNumber: "Resolution 38-2025" }],
				})}
			/>,
		);

		expect(screen.getByText("Resolution 38-2025")).toBeDefined();
		expect(screen.queryByText(/Ord\. #/)).toBeNull();
	});

	it("labels a bare number", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					fiscalDecisions: [{ ...base, ordinanceNumber: "38-2025" }],
				})}
			/>,
		);

		expect(screen.getByText("No. 38-2025")).toBeDefined();
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

		screen.getByText(
			"This summary was built from the meeting video and the official documents.",
		);
		expect(screen.queryByText(/video alone/)).toBeNull();
		expect(screen.queryByText("Video only")).toBeNull();
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

		screen.getByText("This summary was built from the official documents.");
		screen.getByRole("link", { name: /View minutes PDF/ });
		expect(screen.queryByRole("link", { name: /video/i })).toBeNull();
		expect(screen.queryByText(/video alone/)).toBeNull();
		screen.getByText("Key Highlights");
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
		screen.getByText("Key Highlights");
		screen.getByText("Sale Street Road Repairs");
		expect(screen.queryByText(/couldn't extract readable text/)).toBeNull();
	});

	it("still says minutes are not yet posted when a video-only summary's only document is an agenda", () => {
		render(
			<MeetingDetailView
				meeting={makeMeeting({
					documents: [
						{
							sourceUrl: "https://example.gov/agenda.pdf",
							rawText: "Agenda text.",
							documentType: "agenda",
							extractionMethod: "text-layer",
						},
					],
					summarySources: { origin: "video", videoUrl: VIDEO_URL },
				})}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain(
			"This summary was built from the meeting video alone. Official minutes are not yet posted.",
		);
		screen.getByRole("link", { name: /View agenda PDF/ });
	});

	it("does not claim minutes are unposted when minutes are attached to a video-only summary", () => {
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
		screen.getByRole("link", { name: /View minutes PDF/ });
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
			"The summary uses the documents' figure, except where a point says the documents' figure could not be read.",
		);
		const items = within(section).getAllByRole("listitem");
		const expected = [
			{ topic: "Paving bid", documents: "$215,215.10", video: "$244,215.10" },
			{ topic: "Wheel tax vote", documents: "Passed 4–1", video: "Passed 5–0" },
		];
		expect(items).toHaveLength(expected.length);
		expected.forEach((want, i) => {
			const item = items[i];
			within(item).getByText(want.topic);
			// Each value must sit in the line under its own label.
			const documentsLine = within(item)
				.getByText("The documents say:")
				.closest("p");
			const videoLine = within(item).getByText("The video says:").closest("p");
			expect(documentsLine?.textContent).toContain(want.documents);
			expect(documentsLine?.textContent).not.toContain(want.video);
			expect(videoLine?.textContent).toContain(want.video);
			expect(videoLine?.textContent).not.toContain(want.documents);
		});
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

		expect(
			screen.queryByRole("region", {
				name: "Where the video and the documents differ",
			}),
		).toBeNull();
		expect(screen.queryByText(/documents' figure/)).toBeNull();
	});
});
