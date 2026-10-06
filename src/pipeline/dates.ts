/**
 * Shared date parsing helpers for the scraping + storage pipeline.
 *
 * All pipeline code converges on ISO `YYYY-MM-DD` dates for the
 * `meetings.date` column. External sources give us various formats —
 * eGov uses MM/DD/YYYY in its listing table cells; Finalsite uses long-form
 * "Month Day, Year"; document titles embed the real meeting date in
 * long form ("December 22, 2025") or numeric form ("03-23-26"). Keeping
 * every converter and the month lookup in one module eliminates the drift
 * that used to happen when two files carried their own MONTHS map.
 */

/**
 * Month name → zero-padded number. The `as const satisfies` form keeps the
 * value types narrow (`"01" | ... | "12"`) while enforcing the
 * `Record<string, string>` shape — so `keyof typeof MONTH_BY_NAME` is the
 * 12-month union, not `string`.
 */
export const MONTH_BY_NAME = {
	january: "01",
	february: "02",
	march: "03",
	april: "04",
	may: "05",
	june: "06",
	july: "07",
	august: "08",
	september: "09",
	october: "10",
	november: "11",
	december: "12",
} as const satisfies Record<string, string>;

export type MonthName = keyof typeof MONTH_BY_NAME;

/**
 * The zero-padded month number for a month name in any case, or null when the
 * word is not a month. An own-key check, so words that name inherited object
 * properties ("constructor") are not months.
 */
function monthNumber(name: string): (typeof MONTH_BY_NAME)[MonthName] | null {
	const key = name.toLowerCase();
	return Object.hasOwn(MONTH_BY_NAME, key)
		? MONTH_BY_NAME[key as MonthName]
		: null;
}

/**
 * Extracts the real meeting date from a document title in the eGov portal.
 *
 * Background: the eGov listing table's date column is the *publish* date
 * (when the document was uploaded to the portal), which tends to collapse
 * to the day staff posted a batch — not the meeting date itself. The
 * authoritative meeting date is embedded in the title, in one of two forms:
 * long ("Town Council Meeting Minutes December 22, 2025") or numeric with a
 * two-digit year ("Town Council Meeting Minutes 03-23-26", "... 12-9-24").
 * The long form wins when a title carries both, because numbered documents
 * ("Ordinance 2025-14 Adopted December 22, 2025") put digit runs before it.
 *
 * Returns ISO YYYY-MM-DD on success, or null when the title has no
 * recognizable date or names a day that does not exist. See issues #27 and #115.
 */
export function extractMeetingDateFromTitle(title: string): string | null {
	return extractLongFormDate(title) ?? extractNumericDate(title);
}

function extractLongFormDate(title: string): string | null {
	const match = title.match(
		/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,\s*|\s+)(\d{4})\b/i,
	);
	if (!match) return null;
	const month = monthNumber(match[1]);
	if (!month) return null;
	const day = match[2].padStart(2, "0");
	const iso = `${match[3]}-${month}-${day}`;
	return isCalendarDate(iso) ? iso : null;
}

function extractNumericDate(title: string): string | null {
	const match = title.match(/(?<![\d-])(\d{1,2})-(\d{1,2})-(\d{2})(?![\d-])/);
	if (!match) return null;
	const iso = `20${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
	return isCalendarDate(iso) ? iso : null;
}

/** True when an ISO `YYYY-MM-DD` string names a day that exists. */
function isCalendarDate(iso: string): boolean {
	const parsed = new Date(`${iso}T00:00:00Z`);
	return (
		!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso
	);
}

/**
 * What a Finalsite date cell says. `month-only` is a known month name and a
 * four-digit year with no day (e.g. "September 2025"): such a row is not a
 * dated meeting. `unreadable` is everything else the reader cannot turn into
 * a day that exists.
 */
export type FinalsiteDateReading =
	| { kind: "dated"; date: string }
	| { kind: "month-only" }
	| { kind: "unreadable" };

/**
 * Reads a Finalsite date cell. "Month Day[, Year]" (e.g. "January 6, 2026")
 * becomes an ISO date, taking `year` when the label carries none.
 */
export function readFinalsiteDate(
	label: string,
	year: number,
): FinalsiteDateReading {
	const monthOnly = label.match(/^([A-Za-z]+)\s+\d{4}$/);
	if (monthOnly && monthNumber(monthOnly[1])) {
		return { kind: "month-only" };
	}

	const match = label.match(/^(\w+)\s+(\d+),?\s*(\d+)?$/);
	if (!match) return { kind: "unreadable" };
	const month = monthNumber(match[1]);
	if (!month) return { kind: "unreadable" };
	const day = match[2].padStart(2, "0");
	const parsedYear = match[3] ? Number(match[3]) : year;
	const iso = `${parsedYear}-${month}-${day}`;
	return isCalendarDate(iso)
		? { kind: "dated", date: iso }
		: { kind: "unreadable" };
}
