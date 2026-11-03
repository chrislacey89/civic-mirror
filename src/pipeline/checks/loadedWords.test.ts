import { describe, expect, it } from "vitest";
import { LOADED_WORDS, loadedWordsCheck } from "./loadedWords.ts";
import type { CheckContext, WriteUp } from "./types.ts";

const context: CheckContext = {
	input: { sources: [], meetingContext: "Town Council, May 27, 2025" },
	ledger: [],
	officials: [],
};

function draftOf(prose: string, highlights: string[] = []): WriteUp {
	return { highlights, prose };
}

function a2(prose: string, highlights: string[] = []) {
	return loadedWordsCheck.run(draftOf(prose, highlights), context).A2;
}

describe("loadedWordsCheck", () => {
	it("fails A2 and quotes the sentence when the prose uses a listed loaded word", () => {
		expect(
			a2("The council met. A resident slammed the plan for the park."),
		).toEqual({
			outcome: "fail",
			evidence:
				'loaded word "slammed": "A resident slammed the plan for the park."',
		});
	});

	it("passes prose that reports without judging", () => {
		expect(a2("A resident asked the council to delay the park plan.")).toEqual({
			outcome: "pass",
		});
	});

	it("reads the highlights as well as the prose", () => {
		expect(
			a2("The council met.", ["Controversial rezoning passes"]),
		).toMatchObject({ outcome: "fail" });
	});
});

/** One sentence per listed word or phrase, used the way rubric § A2 bars. */
const POSITIVE_FIXTURES = [
	"A resident slammed the plan for the park.",
	"The rezoning sparked debate among residents.",
	"The rezoning sparked controversy.",
	"The council took up the controversial rezoning.",
	"After a heated debate, the council voted 3-2.",
	"A heated discussion followed the report.",
	"The two members had a heated exchange.",
	"The council finally approved the sewer rates.",
	"The ordinance finally passed on a 4-1 vote.",
	"The council finally adopted the budget.",
	"The raise is merely 2%.",
	"Sadly, the pool will stay closed.",
	"The manager admitted the project ran late.",
	"The contractor claimed the delay was the weather.",
	"The chief insisted the department needs two officers.",
	"The clerk pointed out the fund is overspent.",
];

/**
 * Headlines are written in the present tense, and a list that stores one
 * tense per entry lets them through. One fixture per extra form of an entry.
 */
const HEADLINE_FIXTURES = [
	"Resident slams park plan",
	"Residents slam park plan",
	"Rezoning sparks debate",
	"Rezoning spark debate",
	"Rezoning sparking debate",
	"Ordinance 2025-13 sparks controversy",
	"Rezoning spark controversy",
	"Rezoning sparking controversy",
	"Heated debates over the rezoning",
	"Heated discussions over the budget",
	"Heated exchanges at the meeting",
	"Council finally approves sewer rates",
	"Council finally approve sewer rates",
	"Council finally approving sewer rates",
	"Council finally passes budget",
	"Council finally pass budget",
	"Council finally passing budget",
	"Council finally adopts budget",
	"Council finally adopt budget",
	"Council finally adopting budget",
	"Manager admits project ran late",
	"Managers admit project ran late",
	"Manager admitting project ran late",
	"Contractor claiming the delay was the weather",
	"Chief insists the department needs two officers",
	"Chiefs insist the department needs two officers",
	"Chief insisting the department needs two officers",
	"Clerk points out the fund is overspent",
	"Clerks point out the fund is overspent",
	"Clerk pointing out the fund is overspent",
	"Slamming the plan for the park",
];

/** Sentences that share a word with a listed entry and carry no judgment. */
const NEGATIVE_FIXTURES = [
	"The council approved repairs to the heated pool.",
	"Finally, the council approved the meeting schedule.",
	"The council paid its claims.",
	"This is the only call for projects in 2026.",
	"The board debated the rezoning for an hour.",
	"The town reclaimed the lot for parking.",
];

describe("LOADED_WORDS", () => {
	it.each(POSITIVE_FIXTURES)("fails A2 on %j", (sentence) => {
		expect(a2(sentence)).toMatchObject({ outcome: "fail" });
	});

	it.each(HEADLINE_FIXTURES)("fails A2 on the headline %j", (headline) => {
		expect(a2("The council met.", [headline])).toMatchObject({
			outcome: "fail",
		});
	});

	it.each(NEGATIVE_FIXTURES)("passes %j", (sentence) => {
		expect(a2(sentence)).toEqual({ outcome: "pass" });
	});

	it("gives every entry a positive fixture", () => {
		const unmatched = LOADED_WORDS.filter(
			(phrase) =>
				![...POSITIVE_FIXTURES, ...HEADLINE_FIXTURES].some((sentence) =>
					sentence.toLowerCase().includes(phrase),
				),
		);
		expect(unmatched).toEqual([]);
	});
});
