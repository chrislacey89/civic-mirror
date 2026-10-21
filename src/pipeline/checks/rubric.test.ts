import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "./types.ts";

const rubric = readFileSync("docs/writing-rubric.md", "utf8");

/** The ids the rubric defines: each check opens with its id in bold, as "**A1.". */
const definedIds = new Set(
	[...rubric.matchAll(/^- \*\*([A-Z][A-Z0-9]*)\./gm)].map((match) => match[1]),
);

describe("docs/writing-rubric.md", () => {
	it.each(CHECK_IDS)("defines check %s", (id) => {
		expect(definedIds).toContain(id);
	});
});
