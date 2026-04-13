import "./promise-try-polyfill.ts";
import { extractText, getDocumentProxy } from "unpdf";
import { ocrPdf as defaultOcrPdf } from "./OcrExtractor.ts";

/**
 * Composite PDF text extractor: tries the text-layer path first, falls back
 * to OCR for scanned/image-only PDFs, then enforces the empty-text guard
 * across both paths.
 *
 * Used via `RunPipelineInput.extractPdfText` in the orchestrator, which wraps
 * this call in `Effect.tryPromise` so any thrown error surfaces as a tagged
 * `PipelineExtractError`. Keeping this as a plain async function (not an
 * Effect.Tag service) matches the orchestrator's function-reference seam:
 * tests and the dry-run path substitute a different implementation by passing
 * a different reference, not by reshaping the dependency graph.
 *
 * The internal two-path structure is exposed through the optional `deps`
 * argument so unit tests can drive the wiring without spinning up the real
 * OCR worker. Production callers pass only `bytes` and get the default
 * implementations.
 */
export type PdfExtractorDeps = {
	extractTextLayer: (bytes: ArrayBuffer) => Promise<string>;
	ocrPdf: (bytes: ArrayBuffer) => Promise<string>;
};

async function extractTextLayer(bytes: ArrayBuffer): Promise<string> {
	try {
		// pdfjs (bundled in unpdf) transfers ownership of the underlying buffer,
		// leaving the caller's ArrayBuffer detached. Copy so the OCR fallback can
		// still read the same `bytes` when the text-layer path returns empty.
		const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
		const result = await extractText(pdf, { mergePages: true });
		return result.text;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`PDF text extraction failed: ${message}`);
	}
}

const defaultDeps: PdfExtractorDeps = {
	extractTextLayer,
	ocrPdf: defaultOcrPdf,
};

export async function extractPdfText(
	bytes: ArrayBuffer,
	deps: PdfExtractorDeps = defaultDeps,
): Promise<string> {
	const textLayer = await deps.extractTextLayer(bytes);
	if (textLayer.trim().length > 0) {
		return textLayer;
	}

	const ocrText = await deps.ocrPdf(bytes);

	// Silent-degradation guard, promoted to the composite level. An image-only
	// PDF that tesseract also can't read (too dark, skewed, handwritten) would
	// otherwise flow through the pipeline as an empty summary and zero fiscal
	// decisions — the failure class documented in
	// docs/solutions/patterns/empty-output-silent-degradation-2026-04-11.md.
	// Fail loudly so the orchestrator alerts and the row is not stored. Opt out
	// via ALLOW_EMPTY_PDF_TEXT=1 for smoke-test scenarios with a deliberately
	// blank PDF.
	if (ocrText.trim().length === 0 && !process.env.ALLOW_EMPTY_PDF_TEXT) {
		throw new Error(
			"Both text-layer extraction and OCR returned no text — the PDF may be " +
				"unreadable (too dark, rotated, handwritten). " +
				"Set ALLOW_EMPTY_PDF_TEXT=1 to accept empty extractions.",
		);
	}

	return ocrText;
}
