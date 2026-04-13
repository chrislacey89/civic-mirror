import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ocrPdf } from "./OcrExtractor.ts";

const TEXT_NATIVE_FIXTURE_URL = new URL(
	"./__fixtures__/egov-minutes-sample.pdf",
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
});
