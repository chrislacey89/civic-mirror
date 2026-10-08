import { describe, expect, it } from "vitest";
import { buildSummarizationPrompt } from "./GeminiSummarizer.ts";

describe("buildSummarizationPrompt", () => {
	it("presents a documents source and a transcript source each under its own label", () => {
		const prompt = buildSummarizationPrompt({
			sources: [
				{ kind: "documents", text: "MINUTES TEXT" },
				{ kind: "transcript", text: "CAPTION TEXT" },
			],
			meetingContext: "Town Council, May 27, 2025",
		});

		const documentsLabel = prompt.indexOf("DOCUMENTS");
		const minutes = prompt.indexOf("MINUTES TEXT");
		const transcriptLabel = prompt.indexOf("TRANSCRIPT");
		const captions = prompt.indexOf("CAPTION TEXT");

		expect(prompt).toContain("Town Council, May 27, 2025");
		expect(documentsLabel).toBeGreaterThan(-1);
		expect(minutes).toBeGreaterThan(documentsLabel);
		expect(transcriptLabel).toBeGreaterThan(minutes);
		expect(captions).toBeGreaterThan(transcriptLabel);
	});

	it("puts every document under the one documents label", () => {
		const prompt = buildSummarizationPrompt({
			sources: [
				{ kind: "documents", text: "AGENDA TEXT" },
				{ kind: "documents", text: "MINUTES TEXT" },
			],
			meetingContext: "Town Council, May 27, 2025",
		});

		expect(prompt.match(/DOCUMENTS/g)).toHaveLength(1);
		expect(prompt).toContain("AGENDA TEXT");
		expect(prompt).toContain("MINUTES TEXT");
	});

	it("leaves out the label of a kind that has no source", () => {
		const prompt = buildSummarizationPrompt({
			sources: [{ kind: "transcript", text: "CAPTION TEXT" }],
			meetingContext: "Town Council, May 27, 2025",
		});

		expect(prompt).toContain("TRANSCRIPT");
		expect(prompt).not.toContain("DOCUMENTS");
	});

	it("lists the recorded decisions under their own label, after the sources", () => {
		const prompt = buildSummarizationPrompt({
			sources: [
				{ kind: "documents", text: "MINUTES TEXT" },
				{ kind: "transcript", text: "CAPTION TEXT" },
			],
			meetingContext: "Town Council, November 24, 2025",
			recordedDecisions: [
				{
					title: "Resolution 38-2025 crash team grant",
					description: "Interlocal agreement for a crash investigation team",
					amount: 43900,
					originalAmount: "$43,900.00",
					status: "approved",
					confidence: 0.9,
					isRecurring: false,
				},
			],
		});

		const label = prompt.indexOf("RECORDED DECISIONS");
		const decision = prompt.indexOf(
			"Resolution 38-2025 crash team grant ($43,900.00, approved)",
		);

		expect(label).toBeGreaterThan(prompt.indexOf("CAPTION TEXT"));
		expect(decision).toBeGreaterThan(label);
	});

	it("leaves out the recorded decisions label when none are passed", () => {
		const prompt = buildSummarizationPrompt({
			sources: [
				{ kind: "documents", text: "MINUTES TEXT" },
				{ kind: "transcript", text: "CAPTION TEXT" },
			],
			meetingContext: "Town Council, November 24, 2025",
			recordedDecisions: [],
		});

		expect(prompt).not.toContain("RECORDED DECISIONS");
	});
});
