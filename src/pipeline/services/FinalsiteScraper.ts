import { Context, Effect, Layer } from "effect";
import { JSDOM } from "jsdom";
import { NetworkError, ParseError } from "#/pipeline/errors.ts";

type FinalsiteDocumentType = "agenda" | "minutes" | "notice";

/**
 * A single document attached to a Finalsite meeting listing.
 * Each document has a UUID used for the download URL path.
 */
type FinalsiteDocument = {
	/** Finalsite resource UUID, parsed from the href path. */
	uuid: string;
	/** Normalized document type. */
	documentType: FinalsiteDocumentType;
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
			const meetingType = (cells[1].textContent ?? "")
				.replace(/\s+/g, " ")
				.trim();

			if (!date) continue;

			const documents: FinalsiteDocument[] = [];
			const links = cells[2].querySelectorAll("a[data-resource-uuid]");

			const VALID_DOC_TYPES: FinalsiteDocumentType[] = [
				"agenda",
				"minutes",
				"notice",
			];

			for (const link of links) {
				const uuid = link.getAttribute("data-resource-uuid") ?? "";
				const href = link.getAttribute("href") ?? "";
				const fileName = link.getAttribute("data-file-name") ?? "";
				const linkText = (link.textContent ?? "")
					.trim()
					.toLowerCase() as FinalsiteDocumentType;

				if (!uuid) continue;
				if (!VALID_DOC_TYPES.includes(linkText)) continue;

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

/**
 * Effect teaching note: This is the second implementation of a scraper service,
 * demonstrating how Effect's dependency injection makes implementations swappable.
 * Both EgovScraper and FinalsiteScraper can be provided to the same pipeline —
 * the consumer depends on the Tag, not the concrete implementation. Swapping is
 * just changing which Layer you provide.
 */

interface FinalsiteScraperInterface {
	/** Fetch the Finalsite school board page and parse meeting listings. */
	scrapeListings(): Effect.Effect<
		FinalsiteMeetingListing[],
		NetworkError | ParseError
	>;
	/** Download a PDF document by its UUID and return the raw bytes. */
	downloadDocument(uuid: string): Effect.Effect<ArrayBuffer, NetworkError>;
}

class FinalsiteScraper extends Context.Tag("FinalsiteScraper")<
	FinalsiteScraper,
	FinalsiteScraperInterface
>() {}

type FinalsiteScraperConfig = {
	/** Base URL for the Finalsite school board page. */
	baseUrl: string;
	/** Injectable fetch function for testability. */
	fetchFn?: typeof globalThis.fetch;
};

/**
 * Effect teaching note: Layer.succeed provides a service value directly —
 * used when construction can't fail. Each method wraps its HTTP calls in
 * Effect.tryPromise, converting thrown exceptions into typed NetworkError
 * or ParseError values. The fetchFn parameter enables testing without
 * hitting the real Finalsite server.
 */
function FinalsiteScraperLive(
	config: FinalsiteScraperConfig,
): Layer.Layer<FinalsiteScraper> {
	const fetchFn = config.fetchFn ?? globalThis.fetch;

	return Layer.succeed(FinalsiteScraper, {
		scrapeListings: () =>
			Effect.gen(function* () {
				const html = yield* Effect.tryPromise({
					try: async () => {
						const response = await fetchFn(config.baseUrl);
						if (!response.ok) {
							throw new Error(
								`HTTP ${response.status}: ${response.statusText}`,
							);
						}
						return response.text();
					},
					catch: (error) =>
						new NetworkError({
							url: config.baseUrl,
							message: error instanceof Error ? error.message : String(error),
						}),
				});

				return yield* Effect.try({
					try: () => parseFinalsiteHtml(html),
					catch: (error) =>
						new ParseError({
							source: "finalsite",
							message: error instanceof Error ? error.message : String(error),
						}),
				});
			}),

		downloadDocument: (uuid) =>
			Effect.tryPromise({
				try: async () => {
					const url = new URL(
						`/fs/resource-manager/view/${uuid}`,
						config.baseUrl,
					);
					const response = await fetchFn(url.toString());
					if (!response.ok) {
						throw new Error(`HTTP ${response.status}: ${response.statusText}`);
					}
					return response.arrayBuffer();
				},
				catch: (error) =>
					new NetworkError({
						url: `/fs/resource-manager/view/${uuid}`,
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

export { FinalsiteScraper, FinalsiteScraperLive, parseFinalsiteHtml };
export type {
	FinalsiteDocumentType,
	FinalsiteMeetingListing,
	FinalsiteDocument,
	FinalsiteScraperConfig,
};
