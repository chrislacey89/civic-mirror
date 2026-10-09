import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ocrPdf } from "./OcrExtractor.ts";

const TEXT_NATIVE_FIXTURE_URL = new URL(
	"./__fixtures__/egov-minutes-sample.pdf",
	import.meta.url,
);

// Page 1 of the Ellettsville Town Council minutes for 2025-05-27, scanned
// from a minute book. The paper has red ruled margin lines, and the left one
// runs through the first character of every line of text.
const RULED_PAGE_FIXTURE_URL = new URL(
	"./__fixtures__/ruled-minute-book-page.pdf",
	import.meta.url,
);

async function loadFixtureBytes(url: URL): Promise<ArrayBuffer> {
	const buffer = await readFile(fileURLToPath(url));
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	);
}

// OCR runs tesseract.js over rasterized pages, which is slow (~1-3s/page on
// Apple silicon) and may download traineddata on first run. The 120s budget is
// generous enough for CI runners with a cold traineddata cache.
describe("ocrPdf", () => {
	it("returns recognizable text when given a rasterized printed-text PDF", {
		timeout: 120_000,
	}, async () => {
		// We use the existing text-native fixture deliberately: ocrPdf always
		// rasterizes pages to PNG before recognizing, so it works on any PDF
		// with visible printed text, whether or not a text layer exists. This
		// gives us a deterministic smoke test without shipping a large scanned
		// PDF fixture. Real scanned-PDF verification happens end-to-end during
		// pipeline:run against Ellettsville Town Council historical listings.
		const bytes = await loadFixtureBytes(TEXT_NATIVE_FIXTURE_URL);

		const text = await ocrPdf(bytes);

		expect(text.trim().length).toBeGreaterThan(0);
		// Tesseract makes occasional character-level mistakes on rasterized
		// PDFs; we assert on stable unique tokens likely to survive.
		expect(text.toLowerCase()).toContain("ellettsville");
	});

	it("concatenates multi-page output in page order", {
		timeout: 120_000,
	}, async () => {
		const bytes = await loadFixtureBytes(TEXT_NATIVE_FIXTURE_URL);

		const text = await ocrPdf(bytes);

		// The fixture has page-1 opening content and page-2 adjournment
		// content; verify the concatenation preserves that ordering. We match
		// on loose substrings because OCR may mis-read individual characters.
		const page1 = text.toLowerCase().indexOf("ellettsville");
		const page2 = text.toLowerCase().search(/adjourn/);
		expect(page1).toBeGreaterThanOrEqual(0);
		expect(page2).toBeGreaterThan(page1);
	});

	it("reads a dollar figure that a ruled margin line runs through", {
		timeout: 120_000,
	}, async () => {
		const bytes = await loadFixtureBytes(RULED_PAGE_FIXTURE_URL);

		const text = await ocrPdf(bytes);

		// The figure is the first thing on its line, so the margin line
		// crosses its "$2".
		expect(text).toContain("E & B Paving for\n$244,215.10 and Milestone");
	});

	it("rejects a page whose text is printed in red", {
		timeout: 120_000,
	}, async () => {
		// Reading only the red channel erases red ink, so a page with red body
		// text would come back with those words silently missing.
		const bytes = pdfWithText("1 0 0 rg", "RESOLUTION AMENDED IN RED INK");

		await expect(ocrPdf(bytes)).rejects.toThrow(/red print/i);
	});

	it("reads black text from a page of the same layout", {
		timeout: 120_000,
	}, async () => {
		const bytes = pdfWithText("0 0 0 rg", "RESOLUTION AMENDED IN BLACK INK");

		const text = await ocrPdf(bytes);

		expect(text.toLowerCase()).toContain("resolution");
	});
});

// A one-page PDF with a few large lines of text in the given fill colour.
// pdfjs rebuilds the cross-reference table, so offsets are left as zero.
function pdfWithText(fillColour: string, line: string): ArrayBuffer {
	const stream = [
		"BT",
		fillColour,
		"/F1 28 Tf",
		"50 700 Td",
		`(${line}) Tj`,
		"0 -60 Td",
		`(${line}) Tj`,
		"0 -60 Td",
		`(${line}) Tj`,
		"ET",
	].join("\n");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
	];
	const body = objects
		.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`)
		.join("");
	const text = `%PDF-1.4\n${body}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF\n`;
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(0) as ArrayBuffer;
}
