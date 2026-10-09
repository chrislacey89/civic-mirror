import { describe, expect, it } from "vitest";
import { firstSentence } from "./prose";

describe("firstSentence", () => {
	it("returns the first sentence of multi-sentence prose", () => {
		expect(
			firstSentence("Council approved the budget. It then adjourned."),
		).toBe("Council approved the budget.");
	});

	it("returns the whole string when there is no terminal punctuation", () => {
		expect(firstSentence("Council approved the budget")).toBe(
			"Council approved the budget",
		);
	});

	it("returns an empty string for empty prose", () => {
		expect(firstSentence("")).toBe("");
	});
});
