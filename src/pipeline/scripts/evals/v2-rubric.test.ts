import { describe, expect, it } from "vitest";
import {
	DRAMA_CATEGORIES,
	DRAMA_LEVELS,
	mapSumToLevel,
} from "#/lib/drama-levels.ts";
import { v2 } from "../../../../evals/profiles/v2.ts";

/** Category keys the rubric gives a numbered `## N. key` section. */
function rubricCategories(prompt: string): string[] {
	return [...prompt.matchAll(/^## \d+\. (\w+)$/gm)].map((m) => m[1]);
}

/** `lo–hi → "level"` rows of the rubric's tier table. */
function rubricTiers(
	prompt: string,
): { lo: number; hi: number; level: string }[] {
	return [...prompt.matchAll(/^- (\d+)–(\d+)\s*→ "([\w-]+)"/gm)].map((m) => ({
		lo: Number(m[1]),
		hi: Number(m[2]),
		level: m[3],
	}));
}

describe("v2 rubric", () => {
	it("defines exactly the categories the detector scores", () => {
		expect(rubricCategories(v2.systemPrompt)).toEqual([...DRAMA_CATEGORIES]);
	});

	it("scores no category that reads a speaker's motive or state of mind", () => {
		for (const dropped of [
			"defensive_hedging",
			"timeline_pressure",
			"visible_dissent",
		]) {
			expect(v2.systemPrompt).not.toContain(dropped);
		}
		expect(v2.systemPrompt).not.toMatch(/distrust/i);
	});

	it("states the tier table the code derives the level from", () => {
		const tiers = rubricTiers(v2.systemPrompt);
		expect(tiers.map((t) => t.level)).toEqual([...DRAMA_LEVELS]);
		expect(tiers[0].lo).toBe(0);
		expect(tiers[tiers.length - 1].hi).toBe(DRAMA_CATEGORIES.length * 3);
		for (const { lo, hi, level } of tiers) {
			expect(mapSumToLevel(lo)).toBe(level);
			expect(mapSumToLevel(hi)).toBe(level);
		}
	});

	it("does not call the section Drama Watch", () => {
		expect(v2.promptVersion).toBe("v2");
		expect(v2.systemPrompt).toContain("Civic Mirror Process Watch");
		expect(v2.systemPrompt).not.toMatch(/drama/i);
	});
});
