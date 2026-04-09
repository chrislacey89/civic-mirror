import { JSDOM } from "jsdom";

/**
 * A single document listing extracted from the eGov document center.
 * Represents one row in the HTML table — enough metadata to identify
 * and download the original PDF.
 */
type EgovDocumentListing = {
	/** eGov internal document ID, parsed from the `?id=` query parameter. */
	id: number;
	/** Document title as displayed in the listing (e.g. "Town Council Meeting Minutes December 8, 2025"). */
	title: string;
	/** Date string as shown in the table (MM/DD/YYYY format from eGov). */
	date: string;
	/** Full URL to download/view the document. */
	downloadUrl: string;
};

/**
 * Parses the eGov document center HTML table into structured listings.
 *
 * This is a pure function (string in, data out) with no side effects — the
 * actual HTTP fetch will be handled by a higher-level pipeline step. Keeping
 * parsing separate from fetching makes this trivially testable with fixture HTML.
 *
 * The eGov portal uses a consistent table structure with alternating
 * `eGov_rowOdd` / `eGov_rowEven` CSS classes. Each row contains:
 * - `.eGov_listSortDesc` — date cell (MM/DD/YYYY)
 * - `.eGov_DataCell3 a.eGov_listItemLink` — title with download link (`?view=item&id=N`)
 *
 * Rows that don't match the expected structure (missing cells, missing `id` param)
 * are silently skipped rather than throwing, since the table may contain
 * header rows or other non-document content.
 *
 * @param html - Raw HTML string from the eGov document center page.
 * @returns Array of parsed document listings, in DOM order.
 */
function parseEgovListingHtml(html: string): EgovDocumentListing[] {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const rows = doc.querySelectorAll("tr.eGov_rowOdd, tr.eGov_rowEven");
	const results: EgovDocumentListing[] = [];

	for (const row of rows) {
		const dateCell = row.querySelector(".eGov_listSortDesc");
		const titleLink = row.querySelector(".eGov_DataCell3 a.eGov_listItemLink");

		if (!dateCell || !titleLink) continue;

		const href = titleLink.getAttribute("href") ?? "";
		const idMatch = href.match(/[?&]id=(\d+)/);
		if (!idMatch) continue;

		results.push({
			id: Number.parseInt(idMatch[1], 10),
			title: (titleLink.textContent ?? "").trim(),
			date: (dateCell.textContent ?? "").trim(),
			downloadUrl: href,
		});
	}

	return results;
}

export { parseEgovListingHtml };
export type { EgovDocumentListing };
