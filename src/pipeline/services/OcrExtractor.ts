import "./promise-try-polyfill.ts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createWorker, PSM } from "tesseract.js";
import { getDocumentProxy, renderPageAsImage } from "unpdf";

/**
 * OCRs a PDF by rasterizing each page to an image and running tesseract.js
 * over the images. Used as the fallback path in the composite `extractPdfText`
 * when a PDF has no text layer (image-based / scanned documents).
 *
 * Effect teaching note: Like `extractPdfText`, this is a plain async function
 * rather than a Context.Service — same rationale (swap-the-impl at the
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
 * - `keepRedChannelOnly` — the minute-book paper these scans come from has
 *   red ruled margin lines, and the left one runs through the first character
 *   of every line. Tesseract reads line and character as one shape and
 *   garbles the character, which turns a line-start "$2" into letters.
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
			const { image, strayRedPixels, pixelCount } = await keepRedChannelOnly(
				Buffer.from(png),
			);
			if (strayRedPixels > pixelCount * MAX_STRAY_RED_SHARE) {
				throw new Error(
					`OCR: page ${pageNumber} has red print outside the ruled lines (${strayRedPixels} red pixels); reading the red channel would drop it`,
				);
			}
			const { data } = await worker.recognize(image);
			pages.push(data.text);
		}
		return pages.join("\n\n");
	} finally {
		await worker.terminate();
	}
}

// Share of a page's pixels that may be strongly red away from ruled lines.
// The ruled minute-book page leaves about 0.02% (stray horizontal ruling
// ends); a single line of 12pt red text is about 0.1%.
const MAX_STRAY_RED_SHARE = 0.0005;

// A pixel column is a ruled line when this share of the page's height is
// strongly red in it (margin ruling is slightly broken, so well below 1). A row
// is one when its longest unbroken red run covers this share of the width;
// text rows are many short runs, so they never qualify. Pixels within
// RULING_MARGIN_PX of a ruled line are part of it.
const COLUMN_RULING_SHARE = 0.2;
const ROW_RULING_SHARE = 0.25;
const RULING_MARGIN_PX = 8;

function isStrongRed(pixels: Uint8ClampedArray, offset: number): boolean {
	const red = pixels[offset] ?? 0;
	const other = Math.max(pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
	return red > 150 && red - other > 100;
}

/**
 * Marks every index within `margin` of an index whose count exceeds
 * `threshold`.
 */
function nearLines(
	counts: number[],
	threshold: number,
	margin: number,
): boolean[] {
	const near = new Array<boolean>(counts.length).fill(false);
	counts.forEach((count, index) => {
		if (count <= threshold) return;
		const from = Math.max(0, index - margin);
		const to = Math.min(counts.length - 1, index + margin);
		for (let i = from; i <= to; i++) near[i] = true;
	});
	return near;
}

/**
 * Re-draws a page as greyscale taken from its red channel alone. Red ink is
 * as bright as the paper in that channel, so red ruling disappears, while
 * black and blue ink stay dark. Text printed in red disappears with it, so
 * this also counts the strongly red pixels that are not part of a ruled line;
 * the caller refuses pages where that count says red print would be lost.
 */
async function keepRedChannelOnly(png: Buffer): Promise<{
	image: Buffer;
	strayRedPixels: number;
	pixelCount: number;
}> {
	const image = await loadImage(png);
	const { width, height } = image;
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.drawImage(image, 0, 0);
	const imageData = context.getImageData(0, 0, width, height);
	const pixels = imageData.data;

	const redPerColumn = new Array<number>(width).fill(0);
	const longestRunPerRow = new Array<number>(height).fill(0);
	for (let row = 0; row < height; row++) {
		let run = 0;
		for (let column = 0; column < width; column++) {
			if (isStrongRed(pixels, (row * width + column) * 4)) {
				redPerColumn[column]++;
				run++;
				longestRunPerRow[row] = Math.max(longestRunPerRow[row] ?? 0, run);
			} else {
				run = 0;
			}
		}
	}
	const inRuledColumn = nearLines(
		redPerColumn,
		height * COLUMN_RULING_SHARE,
		RULING_MARGIN_PX,
	);
	const inRuledRow = nearLines(
		longestRunPerRow,
		width * ROW_RULING_SHARE,
		RULING_MARGIN_PX,
	);

	let strayRedPixels = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (isStrongRed(pixels, i)) {
			const pixel = i / 4;
			if (
				!inRuledColumn[pixel % width] &&
				!inRuledRow[Math.floor(pixel / width)]
			) {
				strayRedPixels++;
			}
		}
		pixels[i + 1] = pixels[i] ?? 0;
		pixels[i + 2] = pixels[i] ?? 0;
	}
	context.putImageData(imageData, 0, 0);
	return {
		image: canvas.toBuffer("image/png"),
		strayRedPixels,
		pixelCount: width * height,
	};
}
