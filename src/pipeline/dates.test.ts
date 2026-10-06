import { describe, expect, it } from "vitest";
import * as dates from "#/pipeline/dates.ts";
import {
	extractMeetingDateFromTitle,
	readFinalsiteDate,
} from "#/pipeline/dates.ts";

describe("extractMeetingDateFromTitle", () => {
	it("extracts 'Month Day, Year' from a minutes title", () => {
		expect(
			extractMeetingDateFromTitle(
				"Town Council Meeting Minutes December 22, 2025",
			),
		).toBe("2025-12-22");
	});

	it("extracts 'Month Day, Year' with extra trailing words", () => {
		expect(
			extractMeetingDateFromTitle(
				"Reorganization Board Meeting February 4, 2026 Minutes Approved",
			),
		).toBe("2026-02-04");
	});

	it("extracts the date regardless of preceding body-name prefix", () => {
		expect(
			extractMeetingDateFromTitle(
				"Plan Commission Meeting Agenda October 10, 2025",
			),
		).toBe("2025-10-10");
	});

	it("returns null when no recognizable date is present", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Annual Report"),
		).toBeNull();
	});

	it("handles lowercase and mixed-case month names", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Meeting january 6, 2026"),
		).toBe("2026-01-06");
	});

	it("extracts a long-form date with no space after the comma", () => {
		expect(
			extractMeetingDateFromTitle(
				"Reorganization Board Meeting January 21,2026 Minutes Approved",
			),
		).toBe("2026-01-21");
	});

	it("extracts a numeric 'MM-DD-YY' date from a minutes title", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 03-23-26"),
		).toBe("2026-03-23");
	});

	it("extracts a numeric date with a one-digit month or day", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 12-9-24"),
		).toBe("2024-12-09");
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 8-26-24"),
		).toBe("2024-08-26");
	});

	it("prefers the long-form date when a title carries both forms", () => {
		expect(
			extractMeetingDateFromTitle(
				"Resolution 10-12-25 Adopted December 22, 2025",
			),
		).toBe("2025-12-22");
	});

	it("returns null for a numeric run that is not a calendar date", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 13-45-26"),
		).toBeNull();
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 02-30-26"),
		).toBeNull();
	});

	it("returns null for a long-form date naming a day that does not exist", () => {
		expect(
			extractMeetingDateFromTitle(
				"Town Council Meeting Minutes February 30, 2026",
			),
		).toBeNull();
	});

	it("returns null for a four-digit-year numeric date instead of reading it as 2020", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 03-23-2026"),
		).toBeNull();
	});

	it("returns null for an ISO date instead of reading its tail as a numeric date", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 2011-10-12"),
		).toBeNull();
	});

	it("returns null for a date-shaped run that continues into a longer hyphenated number", () => {
		// Trailing hyphen guard: 03-23-26 followed by -1 is a numbered item.
		expect(
			extractMeetingDateFromTitle("Town Council Meeting Minutes 03-23-26-1"),
		).toBeNull();
		// Leading hyphen guard: 01-02-26 preceded by 2026- is a numbered item.
		expect(
			extractMeetingDateFromTitle("Town Council Resolution 2026-01-02-26"),
		).toBeNull();
	});

	it("returns null for a date-shaped number that follows a document-number word", () => {
		expect(
			extractMeetingDateFromTitle("Town Council Resolution 01-02-26 Minutes"),
		).toBeNull();
	});

	it.each([
		"Town Council Ordinance No. 01-02-26",
		"Town Council Resolution #01-02-26",
		"Town Council RESOLUTION NO 01-02-26",
	])("returns null for the numbered document %j", (title) => {
		expect(extractMeetingDateFromTitle(title)).toBeNull();
	});

	it("reads a numeric date that follows a document number", () => {
		expect(
			extractMeetingDateFromTitle(
				"Town Council Resolution 01-02-26 Adopted 03-23-26",
			),
		).toBe("2026-03-23");
	});
});

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
