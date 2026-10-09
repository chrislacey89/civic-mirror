import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildSummarizationPrompt,
	buildWritingPrompt,
	LEDGER_INSTRUCTIONS,
	WRITING_INSTRUCTIONS,
} from "./GeminiSummarizer.ts";

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

	it("lists unread figures under their own label, by title alone", () => {
		const prompt = buildSummarizationPrompt({
			sources: [
				{ kind: "documents", text: "MINUTES TEXT" },
				{ kind: "transcript", text: "CAPTION TEXT" },
			],
			meetingContext: "Town Council, May 27, 2025",
			unreadFigures: [
				{
					title: "Paving bid award to E & B Paving",
					description: "Accepted the low bid",
					amount: 215215.1,
					originalAmount: "$215,215.10",
					status: "approved",
					confidence: 0.9,
					isRecurring: false,
				},
			],
		});

		const label = prompt.indexOf("UNREAD FIGURES");

		expect(label).toBeGreaterThan(prompt.indexOf("CAPTION TEXT"));
		expect(
			prompt.indexOf("- Paving bid award to E & B Paving\n"),
		).toBeGreaterThan(label);
		expect(prompt).not.toContain("$215,215.10");
	});

	it("leaves out the unread figures label when there are none", () => {
		const prompt = buildSummarizationPrompt({
			sources: [
				{ kind: "documents", text: "MINUTES TEXT" },
				{ kind: "transcript", text: "CAPTION TEXT" },
			],
			meetingContext: "Town Council, May 27, 2025",
			unreadFigures: [],
		});

		expect(prompt).not.toContain("UNREAD FIGURES");
	});
});

describe("the ledger prompt and the writing prompt", () => {
	// A rule about the prose changes what the ledger call returns when the two
	// share a prompt: three repeat runs on 2026-08-10 added two no-dollar hires
	// to fiscalDecisions while a writing rule named "senior hires" as mattering,
	// and three on 2026-02-02 dropped a rates resolution while another writing
	// rule restated rule 2 in shorter words. The two prompts are kept apart.
	it("is the ledger prompt from before any writing rule existed, byte for byte", () => {
		const pinned = readFileSync(
			new URL("./__fixtures__/ledger-instructions.txt", import.meta.url),
			"utf8",
		);
		expect(LEDGER_INSTRUCTIONS).toBe(pinned.trimEnd());
	});

	it("never asks the writing call for fiscal decisions", () => {
		expect(WRITING_INSTRUCTIONS).not.toContain("fiscalDecisions");
		expect(WRITING_INSTRUCTIONS).not.toContain("sourceDisagreements");
		expect(WRITING_INSTRUCTIONS).toContain("LEDGER");
	});

	// Example headlines in the writing rules are invented. Three repeat runs
	// on 2026-10-05 returned a worked example verbatim while it was taken from
	// that meeting's own record.
	it("uses invented example figures, not ones from a stored meeting", () => {
		const examples = WRITING_INSTRUCTIONS.match(/\$[\d,]+(?:\.\d\d)?/g) ?? [];
		expect(examples.length).toBeGreaterThan(0);
		for (const real of ["$139,775.03", "$29,425", "$52,000", "$200,000"]) {
			expect(examples).not.toContain(real);
		}
	});
});

describe("buildWritingPrompt", () => {
	const input = {
		sources: [
			{ kind: "documents" as const, text: "MINUTES TEXT" },
			{ kind: "transcript" as const, text: "CAPTION TEXT" },
		],
		meetingContext: "Town Council, May 26, 2026",
	};

	it("gives the writing call the sources and the ledger, each under its label", () => {
		const prompt = buildWritingPrompt(input, [
			{
				title: "Approve bid for Milestone Contractors",
				description: "",
				amount: 139775.03,
				originalAmount: "$139,775.03",
				status: "approved",
				confidence: 0.9,
				isRecurring: false,
			},
		]);

		expect(prompt.indexOf("DOCUMENTS")).toBeLessThan(
			prompt.indexOf("MINUTES TEXT"),
		);
		expect(prompt.indexOf("TRANSCRIPT")).toBeLessThan(
			prompt.indexOf("CAPTION TEXT"),
		);
		expect(prompt.indexOf("LEDGER")).toBeGreaterThan(
			prompt.indexOf("CAPTION TEXT"),
		);
		expect(prompt).toContain(
			"- Approve bid for Milestone Contractors ($139,775.03, approved)",
		);
		expect(prompt).toContain("Town Council, May 26, 2026");
	});

	it("says so when the ledger is empty, rather than leaving the label bare", () => {
		const prompt = buildWritingPrompt(input, []);
		expect(prompt).toContain("LEDGER:\n---\n(no fiscal decisions)\n---");
	});
});
