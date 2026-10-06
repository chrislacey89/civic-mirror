import { describe, expect, it } from "vitest";
import * as dates from "#/pipeline/dates.ts";
import {
	extractMeetingDateFromTitle,
	isMonthOnlyFinalsiteDate,
	normalizeFinalsiteDate,
} from "#/pipeline/dates.ts";

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
		"September 2025",
	])("returns null for the unreadable label %j", (label) => {
		expect(normalizeFinalsiteDate(label, 2026)).toBeNull();
	});
});

describe("isMonthOnlyFinalsiteDate", () => {
	it.each([
		"September 2025",
		"january 2026",
		"March  2024",
	])("recognises the month-and-year label %j", (label) => {
		expect(isMonthOnlyFinalsiteDate(label)).toBe(true);
	});

	it.each([
		"January 6, 2026",
		"January 6",
		"Sept 2025",
		"Smarch 2025",
		"September 25",
		"September 20255",
		"September 2025 meeting",
		"2025",
		"TBD",
	])("does not recognise %j", (label) => {
		expect(isMonthOnlyFinalsiteDate(label)).toBe(false);
	});
});

/**
 * A meeting's date is half of its natural key, so a reader that substitutes a
 * plausible date for input it cannot read merges distinct meetings silently.
 * Every function this module exports is listed here: a date reader with the
 * call that hands it undated input, anything else by name. A new export fails
 * the first test until it is added to one of the two lists.
 */
describe("date readers never guess", () => {
	const undatedCalls: Record<string, () => string | null> = {
		extractMeetingDateFromTitle: () =>
			extractMeetingDateFromTitle("Town Council Annual Report"),
		normalizeFinalsiteDate: () => normalizeFinalsiteDate("TBD", 2026),
	};
	const notDateReaders = ["isMonthOnlyFinalsiteDate"];

	it("lists every function the module exports", () => {
		const exported = Object.entries(dates)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();
		expect(exported).toEqual(
			[...Object.keys(undatedCalls), ...notDateReaders].sort(),
		);
	});

	it.each(
		Object.entries(undatedCalls),
	)("%s returns null for input that carries no date", (_name, call) => {
		expect(call()).toBeNull();
	});
});
