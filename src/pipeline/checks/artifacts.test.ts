import { describe, expect, it } from "vitest";
import { ARTIFACT_PATTERNS, artifactsCheck } from "./artifacts.ts";
import type { CheckContext, WriteUp } from "./types.ts";

const context: CheckContext = {
	input: { sources: [], meetingContext: "Town Council, May 27, 2025" },
	ledger: [],
	officials: [],
};

function draftOf(prose: string, highlights: string[] = []): WriteUp {
	return { highlights, prose };
}

function a3(prose: string, highlights: string[] = []) {
	return artifactsCheck.run(draftOf(prose, highlights), context).A3;
}

describe("artifactsCheck", () => {
	it("fails A3 and quotes the sentence when the prose names the transcript", () => {
		expect(
			a3(
				"The council paid its bills. According to the transcript, the vote was 4-1.",
			),
		).toEqual({
			outcome: "fail",
			evidence:
				'source artifact "According to the transcript": "According to the transcript, the vote was 4-1."',
		});
	});

	it("passes prose that says only what happened", () => {
		expect(
			a3(
				"The council added $52,000 to the fire department's budget. The vote was 4-1.",
			),
		).toEqual({ outcome: "pass" });
	});

	it("reads the highlights as well as the prose", () => {
		expect(
			a3("The council met.", ["Council approves bid, the captions show"]),
		).toMatchObject({ outcome: "fail" });
	});
});

/** One sentence per artifact, each the kind of leak rubric § A3 names. */
const POSITIVE_FIXTURES = [
	"The transcript records a 4-1 vote.",
	"The captions show the motion carried.",
	"According to the captions, the motion carried.",
	"The vote was 4-1 in the transcript.",
	"The minutes state the bid was the lowest.",
	"According to the minutes, the bid was the lowest.",
	"The documents say the bid was the lowest.",
	"According to the documents, the bid was the lowest.",
	"The record shows a difference of 150.",
	"The chief asked for [inaudible] more officers.",
	"The board heard the report. Page 3 of 7.",
	"The board heard the report [Page 3].",
	"Staff put the cost at 1 million (stated as '1 million JD460').",
	"An internal contradiction put the difference at 150 dollars.",
	"The council approved the �bid.",
	"The council approved the ■ bid.",
];

/** Sentences that share words with an artifact pattern and are not one. */
const NEGATIVE_FIXTURES = [
	"The council approved the minutes of the May 12 meeting.",
	"The mayor signed the documents for the loan.",
	"The town set a record for paving miles.",
	"The board turned the page on the dispute.",
	"The council approved the closed captions contract for the meeting video.",
	"The council approved the transcript service contract.",
	"The council approved the video contract, and the captions will start in May.",
	"The fee is capped at 5 percent, stated as a percentage of revenue.",
];

describe("ARTIFACT_PATTERNS", () => {
	it.each(POSITIVE_FIXTURES)("fails A3 on %j", (sentence) => {
		expect(a3(sentence)).toMatchObject({ outcome: "fail" });
	});

	it.each(NEGATIVE_FIXTURES)("passes %j", (sentence) => {
		expect(a3(sentence)).toEqual({ outcome: "pass" });
	});

	it("gives every pattern a positive fixture", () => {
		const unmatched = ARTIFACT_PATTERNS.filter(
			(pattern) =>
				!POSITIVE_FIXTURES.some((sentence) => pattern.test(sentence)),
		);
		expect(unmatched).toEqual([]);
	});
});
