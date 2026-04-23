import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	EgovScraper,
	EgovScraperLive,
	extractMeetingDateFromTitle,
	parseEgovListingHtml,
} from "./ScraperService.ts";

// Real HTML structure from ellettsville.in.us eGov document center
const EGOV_HTML_FIXTURE = `
<table>
	<tr class="eGov_rowOdd">
		<td class="eGov_listSortDesc" align="center">02/04/2026</td>
		<td class="eGov_DataCell2" align="center"><img src="/egov/imgs/apps/documents/pdf.png" alt="pdf" /></td>
		<td class="eGov_DataCell3" align="left">
			<a class="eGov_listItemLink" href="https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1653">
				Reorganization Board Meeting February 4, 2026 Minutes Approved
			</a>
		</td>
		<td class="eGov_DataCell4" align="center">114</td>
		<td class="eGov_DataCell5" align="right">77 KB</td>
		<td class="eGov_DataCell6" align="center">
			<a class="eGov_listItemLink" href="./center.egov?view=detail&id=1653" title="Details about Reorganization Board Meeting February 4, 2026 Minutes Approved">
				<img src="/egov/imgs/apps/documents/information.png" alt="Details icon" />
			</a>
		</td>
	</tr>
	<tr class="eGov_rowEven">
		<td class="eGov_listSortDesc" align="center">01/14/2026</td>
		<td class="eGov_DataCell2" align="center"><img src="/egov/imgs/apps/documents/pdf.png" alt="pdf" /></td>
		<td class="eGov_DataCell3" align="left">
			<a class="eGov_listItemLink" href="https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1628">
				Town Council Meeting Minutes December 22, 2025
			</a>
		</td>
		<td class="eGov_DataCell4" align="center">253</td>
		<td class="eGov_DataCell5" align="right">853 KB</td>
		<td class="eGov_DataCell6" align="center">
			<a class="eGov_listItemLink" href="./center.egov?view=detail&id=1628" title="Details about Town Council Meeting Minutes December 22, 2025">
				<img src="/egov/imgs/apps/documents/information.png" alt="Details icon" />
			</a>
		</td>
	</tr>
	<tr class="eGov_rowOdd">
		<td class="eGov_listSortDesc" align="center">01/14/2026</td>
		<td class="eGov_DataCell2" align="center"><img src="/egov/imgs/apps/documents/pdf.png" alt="pdf" /></td>
		<td class="eGov_DataCell3" align="left">
			<a class="eGov_listItemLink" href="https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1627">
				Town Council Meeting Minutes December 8, 2025
			</a>
		</td>
		<td class="eGov_DataCell4" align="center">287</td>
		<td class="eGov_DataCell5" align="right">962 KB</td>
		<td class="eGov_DataCell6" align="center">
			<a class="eGov_listItemLink" href="./center.egov?view=detail&id=1627" title="Details about Town Council Meeting Minutes December 8, 2025">
				<img src="/egov/imgs/apps/documents/information.png" alt="Details icon" />
			</a>
		</td>
	</tr>
</table>
`;

describe("EgovScraper", () => {
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
	});

	describe("parseEgovListingHtml", () => {
		it("extracts document metadata from eGov HTML table rows", () => {
			const results = parseEgovListingHtml(EGOV_HTML_FIXTURE);

			expect(results).toHaveLength(3);

			expect(results[0]).toMatchObject({
				id: 1653,
				title: "Reorganization Board Meeting February 4, 2026 Minutes Approved",
				date: "02/04/2026",
				downloadUrl:
					"https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1653",
			});

			expect(results[1]).toMatchObject({
				id: 1628,
				title: "Town Council Meeting Minutes December 22, 2025",
				date: "01/14/2026",
				downloadUrl:
					"https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1628",
			});

			expect(results[2].id).toBe(1627);
		});

		it("returns empty array for HTML with no document rows", () => {
			const results = parseEgovListingHtml("<table></table>");
			expect(results).toEqual([]);
		});

		it("emits meetingDate (ISO) extracted from the title, not the publish-date cell", () => {
			const results = parseEgovListingHtml(EGOV_HTML_FIXTURE);
			// The December 22, 2025 meeting was published on 01/14/2026 in the
			// listing cell, but the real meeting date from the title must win.
			const dec22 = results.find((r) => r.id === 1628);
			expect(dec22?.meetingDate).toBe("2025-12-22");
			const dec8 = results.find((r) => r.id === 1627);
			expect(dec8?.meetingDate).toBe("2025-12-08");
		});

		it("emits documentType inferred from the title", () => {
			const results = parseEgovListingHtml(EGOV_HTML_FIXTURE);
			// All three fixture rows are minutes; verify we infer "minutes" from
			// the title text rather than relying on the scraper's searchType.
			for (const row of results) {
				expect(row.documentType).toBe("minutes");
			}
		});

		it("infers agenda documentType from titles containing 'Agenda'", () => {
			const html = `
<table>
	<tr class="eGov_rowOdd">
		<td class="eGov_listSortDesc">01/14/2026</td>
		<td class="eGov_DataCell3">
			<a class="eGov_listItemLink" href="?view=item&id=2000">
				Town Council Meeting Agenda January 6, 2026
			</a>
		</td>
	</tr>
</table>`;
			const results = parseEgovListingHtml(html);
			expect(results[0].documentType).toBe("agenda");
			expect(results[0].meetingDate).toBe("2026-01-06");
		});

		it("infers ordinance documentType from titles containing 'Ordinance'", () => {
			const html = `
<table>
	<tr class="eGov_rowOdd">
		<td class="eGov_listSortDesc">01/14/2026</td>
		<td class="eGov_DataCell3">
			<a class="eGov_listItemLink" href="?view=item&id=3000">
				Ordinance 2025-14 Adopted December 22, 2025
			</a>
		</td>
	</tr>
</table>`;
			const results = parseEgovListingHtml(html);
			expect(results[0].documentType).toBe("ordinance");
		});

		it("leaves meetingDate null when the title has no extractable date", () => {
			const html = `
<table>
	<tr class="eGov_rowOdd">
		<td class="eGov_listSortDesc">01/14/2026</td>
		<td class="eGov_DataCell3">
			<a class="eGov_listItemLink" href="?view=item&id=4000">
				Town Council Annual Report
			</a>
		</td>
	</tr>
</table>`;
			const results = parseEgovListingHtml(html);
			expect(results[0].meetingDate).toBeNull();
		});
	});

	describe("EgovScraperLive", () => {
		const baseUrl = "https://ellettsville.in.us/egov/apps/document/center.egov";

		it("fetches a listing page and returns parsed documents", async () => {
			const mockFetch: typeof globalThis.fetch = async (url) => {
				const s = String(url);
				if (s.includes("eGov_searchType=12") && s.includes("page=4_1")) {
					return new Response(EGOV_HTML_FIXTURE, { status: 200 });
				}
				return new Response("Not Found", { status: 404 });
			};

			const program = Effect.gen(function* () {
				const scraper = yield* EgovScraper;
				return yield* scraper.scrapeListings({
					searchType: "12",
					page: 1,
				});
			}).pipe(Effect.provide(EgovScraperLive({ baseUrl, fetchFn: mockFetch })));

			const results = await Effect.runPromise(program);
			expect(results).toHaveLength(3);
			expect(results[0].id).toBe(1653);
			expect(results[0].title).toBe(
				"Reorganization Board Meeting February 4, 2026 Minutes Approved",
			);
		});

		it("returns NetworkError when listing fetch fails with non-OK status", async () => {
			const mockFetch: typeof globalThis.fetch = async () =>
				new Response("Server Error", { status: 500 });

			const program = Effect.gen(function* () {
				const scraper = yield* EgovScraper;
				return yield* scraper.scrapeListings({ searchType: "12", page: 1 });
			}).pipe(Effect.provide(EgovScraperLive({ baseUrl, fetchFn: mockFetch })));

			const error = await Effect.runPromise(program.pipe(Effect.flip));
			expect(error._tag).toBe("NetworkError");
		});

		it("returns NetworkError when listing fetch throws", async () => {
			const mockFetch: typeof globalThis.fetch = async () => {
				throw new Error("Connection refused");
			};

			const program = Effect.gen(function* () {
				const scraper = yield* EgovScraper;
				return yield* scraper.scrapeListings({ searchType: "12", page: 1 });
			}).pipe(Effect.provide(EgovScraperLive({ baseUrl, fetchFn: mockFetch })));

			const error = await Effect.runPromise(program.pipe(Effect.flip));
			expect(error._tag).toBe("NetworkError");
			expect(error.message).toContain("Connection refused");
		});

		it("downloads a document by URL", async () => {
			const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
			const mockFetch: typeof globalThis.fetch = async (url) => {
				if (String(url).includes("view=item&id=1653")) {
					return new Response(pdfBytes, { status: 200 });
				}
				return new Response("Not Found", { status: 404 });
			};

			const program = Effect.gen(function* () {
				const scraper = yield* EgovScraper;
				return yield* scraper.downloadDocument(
					"https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1653",
				);
			}).pipe(Effect.provide(EgovScraperLive({ baseUrl, fetchFn: mockFetch })));

			const result = await Effect.runPromise(program);
			expect(new Uint8Array(result)).toEqual(pdfBytes);
		});

		it("returns NetworkError when document download fails", async () => {
			const mockFetch: typeof globalThis.fetch = async () =>
				new Response("Not Found", { status: 404 });

			const program = Effect.gen(function* () {
				const scraper = yield* EgovScraper;
				return yield* scraper.downloadDocument(
					"https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=9999",
				);
			}).pipe(Effect.provide(EgovScraperLive({ baseUrl, fetchFn: mockFetch })));

			const error = await Effect.runPromise(program.pipe(Effect.flip));
			expect(error._tag).toBe("NetworkError");
		});
	});
});
