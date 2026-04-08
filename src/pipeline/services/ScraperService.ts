import { JSDOM } from "jsdom";

type EgovDocumentListing = {
	id: number;
	title: string;
	date: string;
	downloadUrl: string;
};

/**
 * Parses the eGov document center HTML table into structured listings.
 *
 * The eGov portal uses a consistent table structure with alternating
 * eGov_rowOdd/eGov_rowEven classes. Each row contains:
 * - eGov_listSortDesc: date (MM/DD/YYYY)
 * - eGov_DataCell3: title with download link (?view=item&id=N)
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
