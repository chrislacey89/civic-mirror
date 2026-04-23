/**
 * Shared date parsing helpers for the scraping + storage pipeline.
 *
 * All pipeline code converges on ISO `YYYY-MM-DD` dates for the
 * `meetings.date` column. External sources give us various formats —
 * eGov uses MM/DD/YYYY in its listing table cells; Finalsite uses long-form
 * "Month Day, Year"; document titles embed the real meeting date in
 * long form ("December 22, 2025"). Keeping every converter and the month
 * lookup in one module eliminates the drift that used to happen when two
 * files carried their own MONTHS map.
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
 * Extracts the real meeting date from a document title in the eGov portal.
 *
 * Background: the eGov listing table's date column is the *publish* date
 * (when the document was uploaded to the portal), which tends to collapse
 * to the day staff posted a batch — not the meeting date itself. The
 * authoritative meeting date is embedded in the title, e.g.
 * "Town Council Meeting Minutes December 22, 2025".
 *
 * Returns ISO YYYY-MM-DD on success, or null when the title has no
 * recognizable long-form date. Callers decide whether a null means "skip
 * the row" or "fall back to publish date." See issue #27.
 */
export function extractMeetingDateFromTitle(title: string): string | null {
	const match = title.match(
		/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i,
	);
	if (!match) return null;
	const monthKey = match[1].toLowerCase() as MonthName;
	const month = MONTH_BY_NAME[monthKey];
	if (!month) return null;
	const day = match[2].padStart(2, "0");
	const year = match[3];
	return `${year}-${month}-${day}`;
}

/** Converts eGov "MM/DD/YYYY" (listing cell publish date) to ISO "YYYY-MM-DD". */
export function normalizeEgovDate(mmddyyyy: string): string {
	const parts = mmddyyyy.split("/");
	if (parts.length !== 3) return mmddyyyy;
	const [month, day, year] = parts;
	return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Converts Finalsite "Month Day, Year" (e.g. "January 6, 2026") to ISO. */
export function normalizeFinalsiteDate(label: string, year: number): string {
	const match = label.match(/^(\w+)\s+(\d+),?\s*(\d+)?$/);
	if (!match) return `${year}-01-01`;
	const monthName = match[1].toLowerCase() as MonthName;
	const day = match[2].padStart(2, "0");
	const parsedYear = match[3] ? Number(match[3]) : year;
	const month = MONTH_BY_NAME[monthName] ?? "01";
	return `${parsedYear}-${month}-${day}`;
}
