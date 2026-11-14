import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JUDGE_INSTRUCTIONS } from "#/pipeline/services/GeminiJudge.ts";
import { RULES } from "./feedback.ts";
import { CHECK_IDS } from "./types.ts";

const rubric = readFileSync("docs/writing-rubric.md", "utf8");

/**
 * Each check the rubric defines, by id, with its bold title: a check opens
 * with "- **A1. Title.**", and a title may wrap onto the next line.
 */
const titles = new Map(
	[...rubric.matchAll(/^- \*\*([A-Z][A-Z0-9]*)\. ([^*]+?)\.\*\*/gm)].map(
		(match) => [match[1], (match[2] ?? "").replace(/\s+/g, " ")],
	),
);

describe("docs/writing-rubric.md", () => {
	it.each(CHECK_IDS)("defines check %s", (id) => {
		expect(titles.has(id)).toBe(true);
	});

	it.each(CHECK_IDS)("gives feedback for %s the rubric's own title", (id) => {
		expect(RULES[id]).toBe(titles.get(id));
	});

	it("gives the judge A5's test in the rubric's own words", () => {
		const a5 = rubric.slice(rubric.indexOf("- **A5."));
		const test = a5.match(/\*Test: ([^*]+)\*/)?.[1]?.replace(/\s+/g, " ");
		expect(test).toBeDefined();
		const a5Rule =
			JUDGE_INSTRUCTIONS.split("\n").find((line) => line.startsWith("A5.")) ??
			"";
		expect(a5Rule).toContain(`Test: ${test}`);
	});
});
