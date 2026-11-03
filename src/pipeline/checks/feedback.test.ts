import { describe, expect, it } from "vitest";
import { figuresIn } from "#/pipeline/figureMatch.ts";
import { artifactsCheck } from "./artifacts.ts";
import { feedbackFrom } from "./feedback.ts";
import { runCodeChecks } from "./index.ts";
import { loadedWordsCheck } from "./loadedWords.ts";
import type { CheckContext, CheckReport, WriteUp } from "./types.ts";

const MINUTES = `
Pamela Samples made a motion to enter into an agreement to explore
reorganization with the Township of Richland. William Ellis seconded. Roll call
vote: Scott Oldham — no; Dan Swafford — yes; William Ellis —
yes; Trevor Sager — yes; Pamela Samples — yes. Motion carries.

The council accepted the paving bid of $139,775.03 from Milestone Contractors.
`;

const context: CheckContext = {
	input: {
		sources: [{ kind: "documents", text: MINUTES }],
		meetingContext: "Town Council, May 27, 2025",
	},
	ledger: [],
	officials: [],
};

const draft: WriteUp = {
	highlights: ["Council spends $62,500 on salt"],
	prose:
		"The council voted 5-0 to explore reorganization with Richland Township. It accepted a $139,775 paving bid. The council will",
};

function textOf(feedback: ReturnType<typeof feedbackFrom>): string {
	return feedback.map(({ quote, finding }) => `${quote} ${finding}`).join("\n");
}

describe("feedbackFrom", () => {
	const report = runCodeChecks(draft, context);
	const feedback = feedbackFrom(report, draft);
	const draftText = [...draft.highlights, draft.prose].join("\n");

	it("quotes the draft text each failed check found, verbatim, under its check id", () => {
		expect(feedback.map((item) => item.checkId)).toEqual(
			expect.arrayContaining(["A1", "TRUNC", "G1"]),
		);
		for (const item of feedback) {
			expect(item.quote).not.toBe("");
			expect(draftText).toContain(item.quote);
		}
		expect(feedback.find((item) => item.checkId === "TRUNC")?.quote).toContain(
			"The council will",
		);
	});

	it("names no figure and no name the draft does not", () => {
		const text = textOf(feedback);
		const draftValues = new Set(figuresIn(draftText).map((f) => f.value));
		for (const figure of figuresIn(text)) {
			expect(draftValues).toContain(figure.value);
		}
		expect(text).not.toContain("139,775.03");
		expect(text).not.toContain("4 yes");
		for (const name of ["Oldham", "Swafford", "Samples", "Milestone"]) {
			expect(text).not.toContain(name);
		}
	});

	it("lists failed and unchecked gates before failed style checks", () => {
		const ids = feedback.map((item) => item.checkId);
		expect(ids.indexOf("G1")).toBeGreaterThan(ids.lastIndexOf("TRUNC"));
		expect(ids.indexOf("G1")).toBeGreaterThan(ids.lastIndexOf("A1"));
	});

	it("gives feedback for an unchecked gate, and none for a passing check", () => {
		const unchecked: CheckReport = {
			verdicts: {
				A1: {
					outcome: "unchecked",
					reason: `"voted 5-0" cannot be counted from the record: "The council voted 5-0 to explore reorganization with Richland Township."`,
				},
				TRUNC: { outcome: "pass" },
				B3: { outcome: "pass" },
			},
		};
		const items = feedbackFrom(unchecked, draft);
		expect(items).toHaveLength(1);
		expect(items[0]?.checkId).toBe("A1");
		expect(items[0]?.quote).toBe(
			"The council voted 5-0 to explore reorganization with Richland Township.",
		);
	});

	it("gives no feedback when every check passes", () => {
		expect(
			feedbackFrom({ verdicts: { A1: { outcome: "pass" } } }, draft),
		).toEqual([]);
	});

	describe("for A5, whose evidence blanks the name", () => {
		const named: WriteUp = {
			highlights: [],
			prose:
				"The council met. Ada Lovelace asked about flooding on Elm Street. It adjourned.",
		};

		it("quotes the draft sentence with the name back in it, and names the rule", () => {
			const items = feedbackFrom(
				{
					verdicts: {
						A5: {
							outcome: "fail",
							evidence:
								'a resident at public comment is named: "[name] asked about flooding on Elm Street." (name at 0)',
						},
					},
				},
				named,
			);
			expect(items).toEqual([
				{
					checkId: "A5",
					quote: "Ada Lovelace asked about flooding on Elm Street.",
					finding: "names a resident who spoke at public comment",
				},
			]);
		});

		it("does the same for an unresolved name", () => {
			const items = feedbackFrom(
				{
					verdicts: {
						A5: {
							outcome: "unchecked",
							reason:
								'a name is on no officials list and has no role in the documents: "[name] asked about flooding on Elm Street." (name at 0)',
						},
					},
				},
				named,
			);
			expect(items[0]?.quote).toBe(
				"Ada Lovelace asked about flooding on Elm Street.",
			);
			expect(items[0]?.finding).toBe(
				"names a person who is on no officials list and has no role in the documents",
			);
		});
	});
	describe("for A2 and A3, whose evidence quotes a matched word and its sentence", () => {
		function feedbackOfCheck(
			check: typeof loadedWordsCheck | typeof artifactsCheck,
			prose: string,
		) {
			const written: WriteUp = { highlights: [], prose };
			return feedbackFrom({ verdicts: check.run(written, context) }, written);
		}

		it("names the loaded word as the draft writes it, and quotes the whole sentence around quote marks", () => {
			const sentence =
				'The chief called the plan "Controversial" in his report.';
			expect(feedbackOfCheck(loadedWordsCheck, sentence)).toEqual([
				{
					checkId: "A2",
					quote: sentence,
					finding:
						'"Controversial" is a loaded word, a judgment the record does not make',
				},
			]);
		});

		it("names the source artifact the same way", () => {
			const sentence = "According to the transcript, the vote was 4-1.";
			expect(feedbackOfCheck(artifactsCheck, sentence)).toEqual([
				{
					checkId: "A3",
					quote: sentence,
					finding:
						'"According to the transcript" is a source artifact the write-up leaks',
				},
			]);
		});

		it("reads a matched artifact that ends in a quote mark", () => {
			const sentence = 'The amount was stated as "five dollars" in the bid.';
			const items = feedbackOfCheck(artifactsCheck, sentence);
			expect(items[0]?.quote).toBe(sentence);
			expect(items[0]?.finding).toContain('"stated as ""');
		});
	});
});
