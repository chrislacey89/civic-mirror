import { describe, expect, it } from "vitest";
import { normalizeFinalsiteDate } from "#/pipeline/dates.ts";

describe("normalizeFinalsiteDate", () => {
	it("reads a long-form date", () => {
		expect(normalizeFinalsiteDate("January 6, 2026", 2026)).toBe("2026-01-06");
	});

	it("falls back to the panel year when the label has none", () => {
		expect(normalizeFinalsiteDate("January 6", 2026)).toBe("2026-01-06");
	});

	it.each([
		"Jan. 6, 2026",
		"Tuesday, January 6",
		"Sept 8, 2025",
		"February 30, 2026",
		"TBD",
	])("returns null for the unreadable label %j", (label) => {
		expect(normalizeFinalsiteDate(label, 2026)).toBeNull();
	});
});
