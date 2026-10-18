import { describe, expect, it } from "vitest";
import { truncationCheck } from "./truncation.ts";
import type { CheckContext } from "./types.ts";

const context: CheckContext = {
	input: { sources: [], meetingContext: "Town Council, May 27, 2025" },
	ledger: [],
};

function verdictFor(prose: string) {
	return truncationCheck.run({ highlights: [], prose }, context).TRUNC;
}

describe("truncationCheck", () => {
	it("owns TRUNC", () => {
		expect(truncationCheck.owns).toEqual(["TRUNC"]);
	});

	it.each([
		["a period", "The council approved the budget."],
		["a question mark", "Who pays for the road?"],
		["an exclamation mark", "The vote was unanimous!"],
		["a closing double quote after a period", 'She said, "We will vote."'],
		["a closing curly quote after a period", "She said, “We will vote.”"],
		["a closing single quote after a question mark", "He asked, 'Why now?'"],
		["a period followed by trailing whitespace", "The council adjourned.\n\n"],
	])("passes prose that ends in %s", (_label, prose) => {
		expect(verdictFor(prose)).toEqual({ outcome: "pass" });
	});

	it.each([
		["a word", "The council approved the purchase of a new"],
		["a comma", "The council approved three purchases,"],
		[
			"a closing quote with no sentence end before it",
			'The item was called "Phase',
		],
		["a colon", "The council approved the following:"],
		["nothing", ""],
	])("fails prose that ends in %s", (_label, prose) => {
		expect(verdictFor(prose)?.outcome).toBe("fail");
	});

	it("quotes the last 80 characters of the prose as evidence", () => {
		const prose = `${"The council met. ".repeat(10)}It then approved a contract with the`;
		expect(verdictFor(prose)).toEqual({
			outcome: "fail",
			evidence: prose.slice(-80),
		});
	});
});
