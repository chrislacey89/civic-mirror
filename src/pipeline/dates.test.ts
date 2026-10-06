import { describe, expect, it } from "vitest";
import * as dates from "#/pipeline/dates.ts";
import {
	extractMeetingDateFromTitle,
	readFinalsiteDate,
} from "#/pipeline/dates.ts";

describe("readFinalsiteDate", () => {
	it("reads a long-form date", () => {
		expect(readFinalsiteDate("January 6, 2026", 2026)).toEqual({
			kind: "dated",
			date: "2026-01-06",
		});
	});

	it("falls back to the panel year when the label has none", () => {
		expect(readFinalsiteDate("January 6", 2026)).toEqual({
			kind: "dated",
			date: "2026-01-06",
		});
	});

	it.each([
		"September 2025",
		"january 2026",
		"March  2024",
	])("reads %j as month-only", (label) => {
		expect(readFinalsiteDate(label, 2026)).toEqual({ kind: "month-only" });
	});

	it.each([
		"Jan. 6, 2026",
		"Tuesday, January 6",
		"Sept 8, 2025",
		"February 30, 2026",
		"TBD",
		"Sept 2025",
		"Smarch 2025",
		"September 20255",
		"September 2025 meeting",
		"2025",
		"Rescheduled September 2025",
		"Constructor 2025",
	])("reads %j as unreadable", (label) => {
		expect(readFinalsiteDate(label, 2026)).toEqual({ kind: "unreadable" });
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
		readFinalsiteDate: () => {
			const reading = readFinalsiteDate("TBD", 2026);
			return reading.kind === "dated" ? reading.date : null;
		},
	};
	const notDateReaders: string[] = [];

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
