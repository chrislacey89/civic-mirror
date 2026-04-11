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
	try {
		const pdf = await getDocumentProxy(new Uint8Array(bytes));
		const { text } = await extractText(pdf, { mergePages: true });
		return text;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`PDF text extraction failed: ${message}`);
	}
}
