import "./promise-try-polyfill.ts";
import { createWorker, PSM } from "tesseract.js";
import { getDocumentProxy, renderPageAsImage } from "unpdf";

/**
 * OCRs a PDF by rasterizing each page to an image and running tesseract.js
 * over the images. Used as the fallback path in the composite `extractPdfText`
 * when a PDF has no text layer (image-based / scanned documents).
 *
 * Effect teaching note: Like `extractPdfText`, this is a plain async function
 * rather than an Effect.Tag service — same rationale (swap-the-impl at the
 * orchestrator input boundary, no additional dependencies to inject from an
 * Effect Context). The tesseract worker lifecycle is managed with a
 * try/finally so the ~150 MB WASM instance is always torn down, even on
 * error. If you wanted Effect's native resource management,
 * `Effect.acquireRelease` would be a clean upgrade path later.
 *
 * Tuning rationale:
 * - `scale: 2.5` — renders at ~180 DPI (PDF base is 72 DPI), which is the
 *   floor where tesseract LSTM delivers good accuracy on printed text.
 *   Lower and output is plausible-looking garbage. Higher costs 2-3x runtime
 *   for diminishing returns.
 * - `user_defined_dpi: "300"` — hint for tesseract's layout heuristics; also
 *   silences its "low-resolution page" warning log.
 * - `PSM.SINGLE_BLOCK` — assumes a single column of text per page, which
 *   matches municipal meeting minute and agenda layouts.
 */
export async function ocrPdf(bytes: ArrayBuffer): Promise<string> {
	// pdfjs (bundled in unpdf) transfers ownership of the underlying buffer on
	// each call, leaving the original ArrayBuffer detached. We hand each unpdf
	// call its own copy so subsequent calls don't fail with "Cannot perform
	// Construct on a detached ArrayBuffer".
	const freshBytes = () => new Uint8Array(bytes.slice(0));

	const pdf = await getDocumentProxy(freshBytes());
	const pageCount = pdf.numPages;

	const worker = await createWorker("eng");
	await worker.setParameters({
		tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
		user_defined_dpi: "300",
	});
	try {
		const pages: string[] = [];
		for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
			const png = await renderPageAsImage(freshBytes(), pageNumber, {
				scale: 2.5,
				canvasImport: () => import("@napi-rs/canvas"),
			});
			const { data } = await worker.recognize(Buffer.from(png));
			pages.push(data.text);
		}
		return pages.join("\n\n");
	} finally {
		await worker.terminate();
	}
}
