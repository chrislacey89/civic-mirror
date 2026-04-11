---
date: 2026-04-11
category: patterns
problem_type: silent production degradation
components: [pipeline, cli, extraction]
technologies: [effect, unpdf, gemini]
severity: high
volatility: evergreen
---

# Empty output from a non-throwing stage is silent degradation

## Problem

A pipeline stage that wraps a real third-party library (not a placeholder) can still produce structurally-valid empty output for real-world input, and if the stage doesn't explicitly check the output for content, downstream stages will silently process garbage. The CLI / orchestrator success count reports success, so exit-code-based verification can't tell the pipeline is degraded.

## Context

Issue #24 shipped a real `unpdf`-backed PDF text extractor, replacing the deliberate `placeholderPdfExtract` stub from PR #23. All the usual signals looked green:

- 7 unit tests passed against a cupsfilter-generated fixture PDF
- A direct spot-check against one real eGov PDF (the newest meeting, 2026-02-04) extracted 4,433 characters of real meeting text
- `pnpm pipeline:dry --body ellettsville-town-council` reported `processed=25 errors=0`
- `pnpm pipeline run --body ellettsville-town-council --skip-crawl-delay` (non-dry) also reported `processed=25 errors=0`

Then a DB query of the produced Turso rows revealed the real picture: of the 25 stored documents, only 4 had real content (3,526–4,433 chars each). The other 21 had `raw_text = " "` — a single whitespace character. The corresponding summaries were empty strings, highlights arrays were empty, and zero fiscal decisions were extracted across the run.

The root cause was that 21 of 25 older eGov PDFs (2026-01-14 and earlier) are **image-based scans** with no text layer. `unpdf.extractText` correctly returns empty text for scanned PDFs — that's what a text-layer extractor does on an image-only PDF. But "empty text extracted without an error" flowed through the same happy-path code as "real text extracted," and the operator's only signal was `errors=0`.

This is the same silent-degradation failure mode documented in `placeholder-stubs-in-production-paths-2026-04-10.md`, one layer deeper. The placeholder case was "our deliberate stub ships as the default." This case is "our real library ships empty output for real-but-off-distribution input." Both produce `processed=N errors=0` while persisting garbage.

## Symptoms

- CLI / pipeline summary reports success: `processed=N errors=0`, no alerts fired, no exceptions logged
- Produced rows look structurally correct — every foreign key is populated, every required column has a value — but the content fields are empty or whitespace
- Downstream LLM calls succeed and return empty arrays or generic prose, because the LLM is being given empty input (LLMs rarely throw on empty input; they apologize and return structured emptiness)
- Running the pipeline against a small subset that happens to match the "in-distribution" shape (e.g. newest listings only) produces perfect results, which makes targeted smoke tests lie
- The only way to catch it is to query the produced data after a real run and look at the *length or content* of the produced rows, not the row count or success metrics

## Root Cause

A pipeline stage has three failure modes:

1. **Throws an exception** — caught by the orchestrator's error handling, counted as an error, alert fires.
2. **Returns malformed / invalid output** — usually caught by the next stage's input validation or type system.
3. **Returns structurally-valid empty output** — passes every downstream type check, doesn't throw, doesn't fail any count-based metric. **Silent degradation.**

Third-party libraries that extract content from external data (PDFs, HTML, media files, LLM responses) default to mode #3 on out-of-distribution inputs. `unpdf.extractText` on a scanned PDF, `cheerio` on HTML with unexpected structure, Whisper on pure silence, a summarization LLM on empty input — all return empty-but-valid output rather than throwing. This is the correct design for the library (not every empty output is an error), but it pushes the "is this output meaningful?" judgment to the caller.

If the caller doesn't make that judgment, the degradation is invisible to exit-code-based verification.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** The feedback loop from "pipeline shipped" to "human notices the data is garbage" is the rate at which someone opens the downstream UI. For a dev-only project, it can be immediate. For an automated ingestion pipeline running on a schedule, it can be days or weeks. The longer the loop, the more garbage rows accumulate, and the more the fix-forward cost grows (data backfill plus code fix).

## Solution

Apply a **liveness guard** at every pipeline stage whose output is content (not count or status). The guard should:

1. Check that the produced content is non-empty by a semantically meaningful measure — `trim().length > 0` at minimum, richer checks (word count, schema match, required field present) when the stage has structure to check.
2. Throw a clear error on empty output, with a message that names the stage and the likely cause.
3. Provide an explicit opt-out via env var for smoke-test scenarios where empty is genuinely expected (e.g. `ALLOW_EMPTY_PDF_TEXT=1`). Matches the shape the placeholder-stub compound doc proposed.
4. Keep the guard **outside** any existing try/catch around the library call, so the guard's semantically precise error message isn't re-wrapped as a generic "extraction failed" message.

The thrown error propagates to the orchestrator's normal error path, which alerts and skips the listing. The operator sees `errors=N` instead of `errors=0` and has a clear signal to investigate.

**Before:**

```typescript
export async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
	const pdf = await getDocumentProxy(new Uint8Array(bytes));
	const { text } = await extractText(pdf, { mergePages: true });
	return text;  // empty string on scanned PDFs — silently flows through
}
```

**After:**

```typescript
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

	// Silent-degradation guard: a valid PDF with no text layer parses
	// successfully but produces no text. Fail loudly so the orchestrator
	// alerts and the row is not stored.
	if (text.trim().length === 0 && !process.env.ALLOW_EMPTY_PDF_TEXT) {
		throw new Error(
			"PDF text extraction returned no text — likely an image-based/scanned " +
				"PDF that needs OCR. Set ALLOW_EMPTY_PDF_TEXT=1 to accept empty extractions.",
		);
	}

	return text;
}
```

The `errors=0 → errors=21` transition on the exact same input set is the signal the guard is working: the pipeline is no longer lying about the shape of the data it's producing.

## Prevention

**Code-level:**

- For any stage that wraps a content-extracting library, add a liveness guard on the output before returning. `trim().length === 0` is the floor; richer checks (word character regex, schema validation, required-field presence, minimum-length heuristic) are better when feasible.
- The guard should **throw**, not return a sentinel or log a warning. Logged warnings don't propagate to error counts; thrown errors do, and surface through the existing alert path.
- Keep an env-var opt-out (`ALLOW_EMPTY_*=1`) so smoke tests and intentional empty-input scenarios can proceed. Never default the opt-out to on.
- Co-locate the guard with the library wrapper, not in the orchestrator. The orchestrator shouldn't have to know *why* output might be empty for each stage — the stage owns that contract.
- Throw the guard error **outside** any try/catch around the library call, so the guard's specific message isn't re-wrapped by a catch-all error handler.

**Process-level:**

- `/write-a-prd` should ask explicitly, for every pipeline stage it shapes: *"If this stage returns empty output for a real input, is that an error? If so, where does the empty-output check live?"* Add this to the omitted activities scan for pipeline and ingestion features.
- `/execute` Step 4 verification ladder: **CLI / pipeline exit counts are not a verification signal for content-producing pipelines.** Tier 3 (Behavioral Verification) should explicitly include "query the produced data in the DB (or output file) and spot-check at least one row's content length and meaningfulness." Don't trust `processed=N errors=0` alone when the point of the pipeline is producing content.
- `/pre-merge` Dimension 7 (Runtime Initialization): for pipeline-touching PRs, require evidence of a non-dry run AND a produced-data query, not just a dry-run exit code.
- For any municipal / external-document ingestion PRD: preemptively flag "mix of text-native and scanned PDFs" as a rabbit hole. Indiana eGov and most US municipal document portals contain a varying mix of scanned and text-native PDFs depending on the body's publication vintage; the split is not visible in the listing HTML. Assume it and plan for OCR fallback from day one.

## Planning / Calibration Notes

- **What widened the work:** roughly 25% of this slice's total effort went into the guard, the blank-PDF fixture, the Turso cleanup, and the re-verification cycle — all triggered by the non-dry runtime check. Unit tests and dry-run had both reported green; only DB inspection caught the issue.
- **What tightened the work:** the existing `placeholder-stubs-in-production-paths-2026-04-10.md` compound doc provided an exact template for the guard shape (env-var opt-out, fail-fast outside the error wrapper), so drafting the fix took minutes, not hours. The compound loop compounded.
- **Future planning adjustment:**
  - `/write-a-prd` should treat "stage that wraps a content-extracting library" as a canonical rabbit-hole class and probe for empty-output handling during shaping.
  - `/research` for ingestion PRDs should specifically investigate the input distribution — "how many of the real inputs are in the shape the library handles well?" — not just "does the library support the format on paper?"
  - `/execute` verification defaults for pipeline slices should be DB content inspection, not CLI exit codes.

## Actuals Worth Reusing

- **Comparable future work:** any pipeline stage wrapping a library that extracts content from external data — PDFs, HTML, video, audio, images, LLMs. Specifically relevant to any slice that plans to add OCR, ASR, vision models, or HTML extractors to an existing pipeline.
- **Reusable baseline:** expect ~20–30% effort overhead on a first implementation when the input distribution is broad enough to include off-distribution cases. Budget it; don't hope for `errors=0` on the first run.
- **Reusable pattern:** the liveness guard plus env-var opt-out plus "throw outside the error wrapper" shape from `src/pipeline/services/PdfExtractor.ts`. Copy the 10-line structure into the next similar stage.

## Key Decision

**Decision:** Add a fail-fast liveness guard in `PdfExtractor.ts` and ship the slice, rather than expanding scope to include OCR or halting until OCR lands.

**Rationale:** OCR is a larger scope (tesseract vs hosted OCR decision, cost/accuracy trade-off, binary dependency or API key handling, testing strategy) that deserves its own PRD. Shipping the real extractor with a loud guard (a) closes the original issue #24, (b) removes the placeholder footgun, (c) gives the operator a clear signal about the unresolved portion — 21 errors per run until OCR lands — and (d) preserves the silent-degradation prevention goal of the predecessor compound doc.

**Alternatives considered:**

- *Ship without the guard and file a follow-up.* Rejected — would ship known silent degradation, the exact class of problem the prior compound doc warned against.
- *Expand scope to include OCR.* Rejected — OCR is a larger-than-one-slice effort and dragging it in would push the original slice's delivery date unpredictably. The compound doc's silent-degradation principle does not require the underlying fix, only a loud failure.
- *Halt and re-research.* Rejected — the original slice's goal was still valid, and the guard plus follow-up issue is a complete, coherent delivery.

**Revisable:** Yes, when OCR lands (tracked in #26). The guard's error message already points the operator at OCR as the fix.

## Related

- `docs/solutions/patterns/placeholder-stubs-in-production-paths-2026-04-10.md` — the direct predecessor; tonight's case is the "real library returns empty" version of the same pattern. Together these two form the backbone of a silent-failure principle for content-producing pipeline stages.
- `docs/solutions/patterns/boundary-map-drift-between-slices-2026-04-10.md` — same sibling directory; the three patterns together cluster around "silent failures in pipeline stages that exit-code-based verification misses."
- PR #28 — https://github.com/chrislacey89/civic-mirror/pull/28 (the slice that triggered this lesson)
- Issue #24 — the slice issue, closed by PR #28
- Issue #26 — OCR fallback for image-based eGov PDFs; will resolve the `errors=21` state the guard produces
- Issue #27 — eGov scraper date parsing collapses distinct documents to same date; separate bug surfaced during verification

## Shelf Life

Evergreen — the principle generalizes to any content-extraction pipeline stage. The specific unpdf / PDF case for older Ellettsville eGov content ends when OCR lands (#26), but the broader pattern — guard empty output from non-throwing stages, and don't trust exit-code-based verification for content pipelines — applies forever to pipeline architecture.
