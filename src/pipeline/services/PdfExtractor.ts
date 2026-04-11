import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extracts plain text from a PDF byte buffer.
 *
 * Uses unpdf (a serverless build of PDF.js) so this works in Node, Bun, and
 * Edge runtimes without a native dependency. `extractText` with
 * `mergePages: true` returns the concatenated text of every page in order,
 * which is the shape the summarization stage expects.
 *
 * Effect teaching note: This module exposes a plain async function rather
 * than an Effect Context.Tag service. The reason is shape-of-the-contract:
 * the orchestrator takes `extractPdfText` as a function parameter on
 * `RunPipelineInput`, not from the Effect context, and wraps the call in
 * `Effect.tryPromise` so any thrown error becomes a tagged
 * `PipelineExtractError`. Wrapping this in a Tag would add an extra indirection
 * without changing the dependency graph — the orchestrator would still need a
 * way to pass it in for tests. Keeping it a function keeps the swap-the-impl
 * pattern (placeholder for dry-run vs real for production) as a simple
 * function reference.
 */
export async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
	let text: string;
	try {
		const pdf = await getDocumentProxy(new Uint8Array(bytes));
		const result = await extractText(pdf, { mergePages: true });
		text = result.text;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`PDF text extraction failed: ${message}`);
	}

	// Silent-degradation guard: an image-based/scanned PDF parses without errors
	// but produces no text layer, which would flow through the pipeline as an
	// empty summary and zero fiscal decisions — exactly the failure class the
	// compound doc at docs/solutions/patterns/placeholder-stubs-in-production-paths-2026-04-10.md
	// warned about. Fail loudly so the orchestrator alerts and the row is not
	// stored. Opt-out via ALLOW_EMPTY_PDF_TEXT=1 for smoke-test scenarios where
	// a deliberately blank PDF is expected.
	if (text.trim().length === 0 && !process.env.ALLOW_EMPTY_PDF_TEXT) {
		throw new Error(
			"PDF text extraction returned no text — likely an image-based/scanned " +
				"PDF that needs OCR. Set ALLOW_EMPTY_PDF_TEXT=1 to accept empty extractions.",
		);
	}

	return text;
}
