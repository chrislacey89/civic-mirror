import { describe, expect, it } from "vitest";
import { parseEgovListingHtml } from "./ScraperService.ts";

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
	describe("parseEgovListingHtml", () => {
		it("extracts document metadata from eGov HTML table rows", () => {
			const results = parseEgovListingHtml(EGOV_HTML_FIXTURE);

			expect(results).toHaveLength(3);

			expect(results[0]).toEqual({
				id: 1653,
				title: "Reorganization Board Meeting February 4, 2026 Minutes Approved",
				date: "02/04/2026",
				downloadUrl:
					"https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1653",
			});

			expect(results[1]).toEqual({
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
	});
});
