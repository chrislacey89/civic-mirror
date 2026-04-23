import { Context, Effect, Layer } from "effect";
import { JSDOM } from "jsdom";
import { NetworkError, ParseError } from "#/pipeline/errors.ts";

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

const MONTH_BY_NAME: Record<string, string> = {
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
};

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
function extractMeetingDateFromTitle(title: string): string | null {
	const match = title.match(
		/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i,
	);
	if (!match) return null;
	const month = MONTH_BY_NAME[match[1].toLowerCase()];
	if (!month) return null;
	const day = match[2].padStart(2, "0");
	const year = match[3];
	return `${year}-${month}-${day}`;
}

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

/**
 * Effect teaching note: This is the third implementation of a scraper service —
 * completing the trio alongside FinalsiteScraper and YouTubeScraper. All three
 * follow the same Context.Tag + Layer.succeed pattern with an injected fetchFn,
 * but each has its own service tag so consumers can depend on them independently.
 *
 * EgovScraper is kept deliberately minimal: it fetches pages and downloads
 * documents, nothing else. Crawl-delay enforcement (the eGov 300-second rule)
 * lives in the orchestrator — that's where request ordering is known and where
 * `Effect.sleep` + `Schedule` can space out the per-document downloads without
 * this service having to track its own request state.
 */

type EgovScrapeListingsInput = {
	/** eGov search type code: "11" = agendas, "12" = minutes, "19" = ordinances. */
	searchType: string;
	/** 1-indexed page number within the listing. */
	page: number;
};

interface EgovScraperInterface {
	/** Fetch one listing page from the eGov document center and return parsed rows. */
	scrapeListings(
		input: EgovScrapeListingsInput,
	): Effect.Effect<EgovDocumentListing[], NetworkError | ParseError>;
	/** Download a document's raw bytes from its full eGov URL. */
	downloadDocument(url: string): Effect.Effect<ArrayBuffer, NetworkError>;
}

class EgovScraper extends Context.Tag("EgovScraper")<
	EgovScraper,
	EgovScraperInterface
>() {}

type EgovScraperConfig = {
	/** Base URL for the eGov document center (e.g. https://ellettsville.in.us/egov/apps/document/center.egov). */
	baseUrl: string;
	/** Injectable fetch function for testability. */
	fetchFn?: typeof globalThis.fetch;
};

/**
 * Effect teaching note: `Layer.succeed` provides the service value directly.
 * Each method wraps its fetch call in `Effect.tryPromise`, converting any
 * thrown exceptions or non-OK responses into typed `NetworkError` values.
 * Separating the scrape (fetch) from the parse (pure) lets the service return
 * a `ParseError` distinct from a `NetworkError`, so the orchestrator can
 * choose different recovery paths for each (e.g. retry network errors,
 * skip+alert on parse errors).
 */
function EgovScraperLive(config: EgovScraperConfig): Layer.Layer<EgovScraper> {
	const fetchFn = config.fetchFn ?? globalThis.fetch;

	return Layer.succeed(EgovScraper, {
		scrapeListings: ({ searchType, page }) =>
			Effect.gen(function* () {
				const url = new URL(config.baseUrl);
				url.searchParams.set("app", "4");
				url.searchParams.set("sect", "content");
				url.searchParams.set("page", `4_${page}`);
				url.searchParams.set("eGov_searchType", searchType);

				const html = yield* Effect.tryPromise({
					try: async () => {
						const response = await fetchFn(url.toString());
						if (!response.ok) {
							throw new Error(
								`HTTP ${response.status}: ${response.statusText}`,
							);
						}
						return response.text();
					},
					catch: (error) =>
						new NetworkError({
							url: url.toString(),
							message: error instanceof Error ? error.message : String(error),
						}),
				});

				return yield* Effect.try({
					try: () => parseEgovListingHtml(html),
					catch: (error) =>
						new ParseError({
							source: "egov",
							message: error instanceof Error ? error.message : String(error),
						}),
				});
			}),

		downloadDocument: (url) =>
			Effect.tryPromise({
				try: async () => {
					const response = await fetchFn(url);
					if (!response.ok) {
						throw new Error(`HTTP ${response.status}: ${response.statusText}`);
					}
					return response.arrayBuffer();
				},
				catch: (error) =>
					new NetworkError({
						url,
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

export {
	parseEgovListingHtml,
	extractMeetingDateFromTitle,
	EgovScraper,
	EgovScraperLive,
};
export type { EgovDocumentListing, EgovScraperConfig, EgovScrapeListingsInput };
