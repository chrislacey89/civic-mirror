import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
