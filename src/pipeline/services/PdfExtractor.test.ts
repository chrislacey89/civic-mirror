import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { extractPdfText, type PdfExtractorDeps } from "./PdfExtractor.ts";

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
	describe("text-layer path", () => {
		it("returns text with method='text-layer' for a real multi-page PDF", async () => {
			const bytes = await loadFixtureBytes();

			const result = await extractPdfText(bytes);

			expect(result.method).toBe("text-layer");
			expect(result.text).toContain("Ellettsville Town Council");
			expect(result.text).toContain("January 14, 2026");
			expect(result.text).toContain("Mayor Smith");
		});

		it("preserves dollar amounts in the extracted text", async () => {
			const bytes = await loadFixtureBytes();

			const result = await extractPdfText(bytes);

			// Dollar amounts spread across both pages. We check digit groups rather
			// than strict "$12,500.00" formatting because PDF text extractors often
			// tokenize punctuation separately from whitespace.
			expect(result.text).toMatch(/12[,\s]?500/);
			expect(result.text).toMatch(/47[,\s]?850/);
			expect(result.text).toMatch(/112[,\s]?500/);
		});

		it("preserves multi-page text order (page 1 content before page 2 content)", async () => {
			const bytes = await loadFixtureBytes();

			const result = await extractPdfText(bytes);

			const page1Marker = result.text.indexOf("called to order");
			const page2Marker = result.text.indexOf("adjourned at 9:15");

			expect(page1Marker).toBeGreaterThanOrEqual(0);
			expect(page2Marker).toBeGreaterThanOrEqual(0);
			expect(page1Marker).toBeLessThan(page2Marker);
		});
	});

	describe("parse errors", () => {
		// Real parser errors (bad bytes, truncated files) still throw. Only
		// "the PDF had no extractable text" maps to method='unreadable'.
		it("throws for non-PDF input bytes", async () => {
			const garbage = new TextEncoder().encode("this is not a pdf file at all");
			const bytes = garbage.buffer.slice(
				garbage.byteOffset,
				garbage.byteOffset + garbage.byteLength,
			);

			await expect(extractPdfText(bytes)).rejects.toThrow();
		});

		it("throws for truncated PDF bytes", async () => {
			const fixture = await loadFixtureBytes();
			const truncated = fixture.slice(0, 8);

			await expect(extractPdfText(truncated)).rejects.toThrow();
		});
	});

	describe("OCR fallback (with injected deps)", () => {
		// These tests exercise the composite wiring in isolation by injecting
		// fake deps. The real OCR path is covered end-to-end in
		// OcrExtractor.test.ts; here we care only that the composite routes to
		// OCR when (and only when) the text-layer path produces no text.
		const BYTES = new Uint8Array([0]).buffer;

		it("returns method='ocr' when the text layer is empty and OCR produces text", async () => {
			const deps: PdfExtractorDeps = {
				extractTextLayer: vi.fn().mockResolvedValue(""),
				ocrPdf: vi.fn().mockResolvedValue("hello from OCR"),
			};

			const result = await extractPdfText(BYTES, deps);

			expect(result).toEqual({ text: "hello from OCR", method: "ocr" });
			expect(deps.ocrPdf).toHaveBeenCalledOnce();
		});

		it("falls back to OCR when the text layer returns only whitespace", async () => {
			// Regression guard: some scanned PDFs return a literal single space
			// from unpdf.extractText. A naive length check would skip OCR.
			const deps: PdfExtractorDeps = {
				extractTextLayer: vi.fn().mockResolvedValue(" "),
				ocrPdf: vi.fn().mockResolvedValue("real text"),
			};

			const result = await extractPdfText(BYTES, deps);

			expect(result).toEqual({ text: "real text", method: "ocr" });
			expect(deps.ocrPdf).toHaveBeenCalledOnce();
		});

		it("does not invoke OCR when the text layer has content", async () => {
			const ocrPdf = vi
				.fn<(bytes: ArrayBuffer) => Promise<string>>()
				.mockRejectedValue(new Error("OCR should not run"));
			const deps: PdfExtractorDeps = {
				extractTextLayer: vi.fn().mockResolvedValue("text layer content"),
				ocrPdf,
			};

			const result = await extractPdfText(BYTES, deps);

			expect(result).toEqual({
				text: "text layer content",
				method: "text-layer",
			});
			expect(ocrPdf).not.toHaveBeenCalled();
		});
	});

	describe("unreadable outcome", () => {
		const BYTES = new Uint8Array([0]).buffer;

		it("returns method='unreadable' with empty text when both paths produce no text", async () => {
			// The silent-degradation guard moved from a thrown error to a tri-state
			// return: the orchestrator now records an unreadable document row
			// rather than treating the meeting as a pipeline failure. The
			// StorageService invariant assertion catches any drift that would try
			// to persist a non-unreadable document with empty text.
			const deps: PdfExtractorDeps = {
				extractTextLayer: vi.fn().mockResolvedValue(""),
				ocrPdf: vi.fn().mockResolvedValue(""),
			};

			const result = await extractPdfText(BYTES, deps);

			expect(result).toEqual({ text: "", method: "unreadable" });
		});

		it("returns method='unreadable' end-to-end for a valid PDF with no extractable text", {
			timeout: 60_000,
		}, async () => {
			const bytes = await loadFixtureBytes(EMPTY_FIXTURE_URL);

			const result = await extractPdfText(bytes);

			expect(result.method).toBe("unreadable");
			expect(result.text.trim()).toBe("");
		});
	});
});
