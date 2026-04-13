import "./promise-try-polyfill.ts";
import { extractText, getDocumentProxy } from "unpdf";
import { ocrPdf as defaultOcrPdf } from "./OcrExtractor.ts";

/**
 * Composite PDF text extractor: tries the text-layer path first, falls back
 * to OCR for scanned/image-only PDFs, then signals the outcome via a tri-state
 * return rather than throwing on empty.
 *
 * Used via `RunPipelineInput.extractPdfText` in the orchestrator. The
 * orchestrator still wraps this call in `Effect.tryPromise` — real parser
 * errors (bad bytes, truncated files) continue to throw — but a PDF with no
 * extractable text now returns `{ text: '', method: 'unreadable' }` so the
 * orchestrator can persist a document row for the meeting instead of dropping
 * it. The previous `ALLOW_EMPTY_PDF_TEXT` env-var escape hatch is retired by
 * the tri-state return.
 *
 * Keeping this as a plain async function (not an Effect.Tag service) matches
 * the orchestrator's function-reference seam: tests and the dry-run path
 * substitute a different implementation by passing a different reference, not
 * by reshaping the dependency graph.
 */
export type ExtractResult = {
	text: string;
	method: "text-layer" | "ocr" | "unreadable";
};

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
): Promise<ExtractResult> {
	const textLayer = await deps.extractTextLayer(bytes);
	if (textLayer.trim().length > 0) {
		return { text: textLayer, method: "text-layer" };
	}

	const ocrText = await deps.ocrPdf(bytes);
	if (ocrText.trim().length > 0) {
		return { text: ocrText, method: "ocr" };
	}

	// Both paths yielded no text. Return the unreadable outcome; the
	// orchestrator is responsible for persisting the meeting with this
	// document flagged as unreadable and skipping summarization + fiscal
	// extraction. The failure class is documented in
	// docs/solutions/patterns/empty-output-silent-degradation-2026-04-11.md —
	// we keep the silent-degradation guard honest by forcing the orchestrator
	// to handle this path explicitly and by asserting in StorageService that
	// non-unreadable documents always carry non-empty text.
	return { text: "", method: "unreadable" };
}
