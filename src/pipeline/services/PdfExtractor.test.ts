import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPdfText } from "./PdfExtractor.ts";

const FIXTURE_URL = new URL(
	"./__fixtures__/egov-minutes-sample.pdf",
	import.meta.url,
);

const EMPTY_FIXTURE_URL = new URL(
	"./__fixtures__/empty-text-sample.pdf",
	import.meta.url,
);

async function loadFixtureBytes(url: URL = FIXTURE_URL): Promise<ArrayBuffer> {
	const buffer = await readFile(fileURLToPath(url));
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	);
}

describe("extractPdfText", () => {
	it("extracts plain text from a real multi-page eGov minutes PDF", async () => {
		const bytes = await loadFixtureBytes();

		const text = await extractPdfText(bytes);

		// Header + body content from page 1
		expect(text).toContain("Ellettsville Town Council");
		expect(text).toContain("January 14, 2026");
		expect(text).toContain("Mayor Smith");
	});

	it("preserves dollar amounts in the extracted text", async () => {
		const bytes = await loadFixtureBytes();

		const text = await extractPdfText(bytes);

		// Dollar amounts spread across both pages. We check digit groups rather
		// than strict "$12,500.00" formatting because PDF text extractors often
		// tokenize punctuation separately from whitespace.
		expect(text).toMatch(/12[,\s]?500/);
		expect(text).toMatch(/47[,\s]?850/);
		expect(text).toMatch(/112[,\s]?500/);
	});

	it("preserves multi-page text order (page 1 content before page 2 content)", async () => {
		const bytes = await loadFixtureBytes();

		const text = await extractPdfText(bytes);

		const page1Marker = text.indexOf("called to order");
		const page2Marker = text.indexOf("adjourned at 9:15");

		expect(page1Marker).toBeGreaterThanOrEqual(0);
		expect(page2Marker).toBeGreaterThanOrEqual(0);
		expect(page1Marker).toBeLessThan(page2Marker);
	});

	it("throws a clear error for non-PDF input bytes", async () => {
		const garbage = new TextEncoder().encode("this is not a pdf file at all");
		const bytes = garbage.buffer.slice(
			garbage.byteOffset,
			garbage.byteOffset + garbage.byteLength,
		);

		await expect(extractPdfText(bytes)).rejects.toThrow();
	});

	it("throws a clear error for truncated PDF bytes", async () => {
		const fixture = await loadFixtureBytes();
		// First 8 bytes = "%PDF-1.3" header but nothing else. Should trip parser.
		const truncated = fixture.slice(0, 8);

		await expect(extractPdfText(truncated)).rejects.toThrow();
	});

	describe("empty-text guard", () => {
		const originalAllowEmpty = process.env.ALLOW_EMPTY_PDF_TEXT;

		beforeEach(() => {
			delete process.env.ALLOW_EMPTY_PDF_TEXT;
		});

		afterEach(() => {
			if (originalAllowEmpty === undefined) {
				delete process.env.ALLOW_EMPTY_PDF_TEXT;
			} else {
				process.env.ALLOW_EMPTY_PDF_TEXT = originalAllowEmpty;
			}
		});

		it("throws a clear error when a valid PDF has no extractable text (likely scanned/image-only)", async () => {
			const bytes = await loadFixtureBytes(EMPTY_FIXTURE_URL);

			await expect(extractPdfText(bytes)).rejects.toThrow(
				/no text|scanned|OCR/i,
			);
		});

		it("returns empty text when ALLOW_EMPTY_PDF_TEXT=1 is set (smoke-test opt-in)", async () => {
			process.env.ALLOW_EMPTY_PDF_TEXT = "1";
			const bytes = await loadFixtureBytes(EMPTY_FIXTURE_URL);

			const text = await extractPdfText(bytes);

			expect(text.trim().length).toBe(0);
		});
	});
});
