import { JSDOM } from "jsdom";

/**
 * A single document attached to a Finalsite meeting listing.
 * Each document has a UUID used for the download URL path.
 */
type FinalsiteDocument = {
	/** Finalsite resource UUID, parsed from the href path. */
	uuid: string;
	/** Normalized document type: "agenda" | "minutes" | "notice". */
	documentType: string;
	/** Relative URL path for downloading the document. */
	downloadUrl: string;
	/** Original filename from the data-file-name attribute. */
	fileName: string;
};

/**
 * A single meeting listing extracted from the Finalsite school board page.
 * Groups all documents for one meeting date together.
 */
type FinalsiteMeetingListing = {
	/** Meeting date as displayed (e.g. "January 6, 2026"). */
	date: string;
	/** Meeting type/description (e.g. "Regular Meeting 6:00 PM"). */
	meetingType: string;
	/** Year extracted from the accordion panel heading. */
	year: number;
	/** Documents attached to this meeting (agenda, minutes, notice). */
	documents: FinalsiteDocument[];
};

/**
 * Parses the Finalsite school board page HTML into structured meeting listings.
 *
 * The Finalsite CMS uses accordion panels (section.fsPanel) organized by year,
 * each containing an HTML table with Date/Type/Links columns. Document links
 * use UUID-based paths: /fs/resource-manager/view/{UUID}.
 *
 * Rows without any document links (future meetings with only &nbsp;) are
 * included with an empty documents array — the pipeline can filter them later.
 *
 * Effect teaching note: Like parseEgovListingHtml, this is a pure function
 * (string in, data out). Keeping parsing separate from HTTP fetching means
 * this can be tested with fixture HTML and composed into an Effect pipeline
 * at a higher level.
 */
function parseFinalsiteHtml(html: string): FinalsiteMeetingListing[] {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const panels = doc.querySelectorAll("section.fsPanel");
	const results: FinalsiteMeetingListing[] = [];

	for (const panel of panels) {
		const yearText =
			panel.querySelector("h2.fsElementTitle")?.textContent?.trim() ?? "";
		const yearMatch = yearText.match(/\d{4}/);
		if (!yearMatch) continue;
		const year = Number.parseInt(yearMatch[0], 10);

		const rows = panel.querySelectorAll("table.table-styled tr");

		for (const row of rows) {
			// Skip header rows
			if (row.querySelector("th")) continue;

			const cells = row.querySelectorAll("td");
			if (cells.length < 3) continue;

			const date = (cells[0].textContent ?? "").trim();
			const meetingType = (cells[1].textContent ?? "").trim();

			if (!date) continue;

			const documents: FinalsiteDocument[] = [];
			const links = cells[2].querySelectorAll("a[data-resource-uuid]");

			for (const link of links) {
				const uuid = link.getAttribute("data-resource-uuid") ?? "";
				const href = link.getAttribute("href") ?? "";
				const fileName = link.getAttribute("data-file-name") ?? "";
				const linkText = (link.textContent ?? "").trim().toLowerCase();

				if (!uuid) continue;

				documents.push({
					uuid,
					documentType: linkText,
					downloadUrl: href,
					fileName,
				});
			}

			results.push({ date, meetingType, year, documents });
		}
	}

	return results;
}

export { parseFinalsiteHtml };
export type { FinalsiteMeetingListing, FinalsiteDocument };
