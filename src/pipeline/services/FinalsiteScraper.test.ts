import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	FinalsiteScraper,
	FinalsiteScraperLive,
	parseFinalsiteHtml,
} from "./FinalsiteScraper.ts";

// Real HTML structure from rbbschools.net/school-board
// Minimal fixture: one year panel with one meeting row containing one document link
const SINGLE_ROW_FIXTURE = `
<section class="fsElement fsPanel fsStyleAutoclear" id="fsEl_10343" role="tabpanel">
	<header>
		<h2 class="fsElementTitle"><a role="button" href="#fs-panel-10343">2026</a></h2>
	</header>
	<div class="fsElementContent">
		<div class="fsElement fsContent">
			<div class="fsElementContent">
				<table class="table-styled">
					<tbody>
						<tr>
							<th scope="col">Date</th>
							<th scope="col">Type</th>
							<th scope="col">Links</th>
						</tr>
						<tr>
							<td><p>January 6, 2026</p></td>
							<td>Board Organizational Meeting 6:00 PM</td>
							<td>
								<p><a data-file-name="1626SchoolBoardOrganizationalMeetingAgenda.pdf" data-resource-uuid="0e57bdf7-c837-4f03-8a79-8a1c69744ee7" href="/fs/resource-manager/view/0e57bdf7-c837-4f03-8a79-8a1c69744ee7" target="_blank">Agenda</a></p>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</section>
`;

// Multi-row fixture with multiple documents per meeting and a row with no links
const MULTI_ROW_FIXTURE = `
<section class="fsElement fsPanel fsStyleAutoclear" id="fsEl_10343" role="tabpanel">
	<header>
		<h2 class="fsElementTitle"><a role="button" href="#fs-panel-10343">2026</a></h2>
	</header>
	<div class="fsElementContent">
		<div class="fsElement fsContent">
			<div class="fsElementContent">
				<table class="table-styled">
					<tbody>
						<tr>
							<th scope="col">Date</th>
							<th scope="col">Type</th>
							<th scope="col">Links</th>
						</tr>
						<tr>
							<td><p>January 20, 2026</p></td>
							<td>Regular Meeting 6:00 PM</td>
							<td>
								<p><a data-file-name="1202026Agenda1.pdf" data-resource-uuid="d165d0db-39de-481e-94e1-74e48e3c7e94" href="/fs/resource-manager/view/d165d0db-39de-481e-94e1-74e48e3c7e94" target="_blank">Agenda</a></p>
								<p><a data-file-name="12026Regualmeetingsignedminutes.pdf" data-resource-uuid="c8621f1b-b572-4add-a921-dd5ca2734c3f" href="/fs/resource-manager/view/c8621f1b-b572-4add-a921-dd5ca2734c3f" target="_blank">Minutes</a></p>
							</td>
						</tr>
						<tr>
							<td><p>February 24, 2026</p></td>
							<td>Special Meeting 6:00 PM</td>
							<td>
								<p><a data-file-name="NoticeofSpecialMeeting22426.pdf" data-resource-uuid="50cd929a-6473-4922-8127-4da839d7a2b7" href="/fs/resource-manager/view/50cd929a-6473-4922-8127-4da839d7a2b7" target="_blank">Notice</a></p>
								<p><a data-file-name="2242026SpecialMeetingAgenda1.pdf" data-resource-uuid="0010f58c-a288-4653-bc00-dfe960112624" href="/fs/resource-manager/view/0010f58c-a288-4653-bc00-dfe960112624" target="_blank">Agenda</a></p>
								<p><a data-file-name="22426Specialmeetingsignedminutes.pdf" data-resource-uuid="91af54e2-e329-4255-84f0-18f891cae1b7" href="/fs/resource-manager/view/91af54e2-e329-4255-84f0-18f891cae1b7" target="_blank">Minutes</a></p>
							</td>
						</tr>
						<tr>
							<td><p>April 21, 2026</p></td>
							<td>Regular Meeting 6:00 PM</td>
							<td><p>&nbsp;</p></td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</section>
`;

// Fixture with thead (2025 uses this variant)
const THEAD_VARIANT_FIXTURE = `
<section class="fsElement fsPanel fsStyleAutoclear" id="fsEl_9352" role="tabpanel">
	<header>
		<h2 class="fsElementTitle"><a role="button" href="#fs-panel-9352">2025</a></h2>
	</header>
	<div class="fsElementContent">
		<div class="fsElement fsContent">
			<div class="fsElementContent">
				<table class="table-styled">
					<thead>
						<tr>
							<th scope="col">Date</th>
							<th scope="col">Type</th>
							<th scope="col">Links</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td><p>January 21, 2025</p></td>
							<td>Board of Finance Meeting 6:00 PM</td>
							<td>
								<p><a data-file-name="01-21-25-Finance-Meeting-Agenda-DRK-1-2.pdf" data-resource-uuid="4a69e480-d97f-457e-81f4-b97cb365c541" href="/fs/resource-manager/view/4a69e480-d97f-457e-81f4-b97cb365c541" target="_blank">Agenda</a></p>
								<p><a data-file-name="01-21-25-Finance-meeting-signed-minutes.pdf" data-resource-uuid="7bf4774d-d7a0-4f76-848c-7f72a47c5293" href="/fs/resource-manager/view/7bf4774d-d7a0-4f76-848c-7f72a47c5293" target="_blank">Minutes</a></p>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</section>
`;

describe("FinalsiteScraper", () => {
	describe("parseFinalsiteHtml", () => {
		it("extracts a single meeting with one document link", () => {
			const results = parseFinalsiteHtml(SINGLE_ROW_FIXTURE);

			expect(results).toHaveLength(1);
			expect(results[0]).toEqual({
				date: "January 6, 2026",
				meetingType: "Board Organizational Meeting 6:00 PM",
				year: 2026,
				documents: [
					{
						uuid: "0e57bdf7-c837-4f03-8a79-8a1c69744ee7",
						documentType: "agenda",
						downloadUrl:
							"/fs/resource-manager/view/0e57bdf7-c837-4f03-8a79-8a1c69744ee7",
						fileName: "1626SchoolBoardOrganizationalMeetingAgenda.pdf",
					},
				],
			});
		});

		it("extracts multiple meetings with multiple documents per row", () => {
			const results = parseFinalsiteHtml(MULTI_ROW_FIXTURE);

			expect(results).toHaveLength(3);

			// First meeting: 2 documents
			expect(results[0].date).toBe("January 20, 2026");
			expect(results[0].meetingType).toBe("Regular Meeting 6:00 PM");
			expect(results[0].year).toBe(2026);
			expect(results[0].documents).toHaveLength(2);
			expect(results[0].documents[0].documentType).toBe("agenda");
			expect(results[0].documents[1].documentType).toBe("minutes");

			// Second meeting: 3 documents (notice + agenda + minutes)
			expect(results[1].date).toBe("February 24, 2026");
			expect(results[1].documents).toHaveLength(3);
			expect(results[1].documents[0].documentType).toBe("notice");

			// Third meeting: future meeting with no documents
			expect(results[2].date).toBe("April 21, 2026");
			expect(results[2].documents).toHaveLength(0);
		});

		it("handles thead variant used in some year panels", () => {
			const results = parseFinalsiteHtml(THEAD_VARIANT_FIXTURE);

			expect(results).toHaveLength(1);
			expect(results[0].date).toBe("January 21, 2025");
			expect(results[0].year).toBe(2025);
			expect(results[0].documents).toHaveLength(2);
		});

		it("handles multiple year panels in one page", () => {
			const combined = SINGLE_ROW_FIXTURE + THEAD_VARIANT_FIXTURE;
			const results = parseFinalsiteHtml(combined);

			expect(results).toHaveLength(2);
			expect(results[0].year).toBe(2026);
			expect(results[1].year).toBe(2025);
		});

		it("returns empty array for HTML with no panels", () => {
			const results = parseFinalsiteHtml("<div>No content</div>");
			expect(results).toEqual([]);
		});

		it("normalizes multiline meeting type text", () => {
			const fixture = `
<section class="fsElement fsPanel fsStyleAutoclear" role="tabpanel">
	<header><h2 class="fsElementTitle"><a>2026</a></h2></header>
	<div class="fsElementContent">
		<div class="fsElement fsContent">
			<div class="fsElementContent">
				<table class="table-styled">
					<tbody>
						<tr><th>Date</th><th>Type</th><th>Links</th></tr>
						<tr>
							<td><p>September 15, 2026</p></td>
							<td>
								<p>Regular Meeting 6:00 PM</p>
								<p>Public Hearing</p>
								<p>Proposed 2027 Budget, 2027 Capital Projects Plan,</p>
								<p>2027 Bus Replacement Plan</p>
							</td>
							<td><p>&nbsp;</p></td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</section>`;
			const results = parseFinalsiteHtml(fixture);

			expect(results).toHaveLength(1);
			// Multiline text should be collapsed to a single line with spaces
			expect(results[0].meetingType).toBe(
				"Regular Meeting 6:00 PM Public Hearing Proposed 2027 Budget, 2027 Capital Projects Plan, 2027 Bus Replacement Plan",
			);
		});

		it("skips rows with empty date cells", () => {
			const fixture = `
<section class="fsElement fsPanel fsStyleAutoclear" role="tabpanel">
	<header><h2 class="fsElementTitle"><a>2026</a></h2></header>
	<div class="fsElementContent">
		<div class="fsElement fsContent">
			<div class="fsElementContent">
				<table class="table-styled">
					<tbody>
						<tr><th>Date</th><th>Type</th><th>Links</th></tr>
						<tr>
							<td></td>
							<td>Orphan row</td>
							<td><p>&nbsp;</p></td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</section>`;
			const results = parseFinalsiteHtml(fixture);
			expect(results).toEqual([]);
		});
	});

	describe("FinalsiteScraperLive", () => {
		it("fetches page HTML and returns parsed listings via Effect", async () => {
			const mockFetch = async (url: string) => {
				if (url === "https://www.rbbschools.net/school-board") {
					return new Response(SINGLE_ROW_FIXTURE, { status: 200 });
				}
				return new Response("Not Found", { status: 404 });
			};

			const program = Effect.gen(function* () {
				const scraper = yield* FinalsiteScraper;
				return yield* scraper.scrapeListings();
			}).pipe(
				Effect.provide(
					FinalsiteScraperLive({
						baseUrl: "https://www.rbbschools.net/school-board",
						fetchFn: mockFetch as typeof globalThis.fetch,
					}),
				),
			);

			const results = await Effect.runPromise(program);
			expect(results).toHaveLength(1);
			expect(results[0].date).toBe("January 6, 2026");
			expect(results[0].documents[0].uuid).toBe(
				"0e57bdf7-c837-4f03-8a79-8a1c69744ee7",
			);
		});

		it("returns NetworkError when fetch fails", async () => {
			const mockFetch = async () => {
				throw new Error("Connection refused");
			};

			const program = Effect.gen(function* () {
				const scraper = yield* FinalsiteScraper;
				return yield* scraper.scrapeListings();
			}).pipe(
				Effect.provide(
					FinalsiteScraperLive({
						baseUrl: "https://www.rbbschools.net/school-board",
						fetchFn: mockFetch as typeof globalThis.fetch,
					}),
				),
			);

			const exit = await Effect.runPromiseExit(program);
			expect(exit._tag).toBe("Failure");
		});

		it("downloads a document by UUID", async () => {
			const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
			const mockFetch = async (url: string) => {
				if (url.includes("/fs/resource-manager/view/")) {
					return new Response(pdfBytes, { status: 200 });
				}
				return new Response("Not Found", { status: 404 });
			};

			const program = Effect.gen(function* () {
				const scraper = yield* FinalsiteScraper;
				return yield* scraper.downloadDocument("test-uuid-1234");
			}).pipe(
				Effect.provide(
					FinalsiteScraperLive({
						baseUrl: "https://www.rbbschools.net/school-board",
						fetchFn: mockFetch as typeof globalThis.fetch,
					}),
				),
			);

			const result = await Effect.runPromise(program);
			expect(new Uint8Array(result)).toEqual(pdfBytes);
		});
	});
});
