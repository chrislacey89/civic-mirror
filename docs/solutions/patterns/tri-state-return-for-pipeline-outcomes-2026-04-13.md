---
date: 2026-04-13
category: patterns
problem_type: silent degradation guard evolves beyond ok/fail
components: [pipeline, orchestrator, extraction, storage]
technologies: [effect, drizzle, typescript]
severity: medium
volatility: stable
---

# Tri-state return replaces throw+env-var when downstream must branch on the outcome

## Problem

A pipeline stage's silent-degradation guard was originally shaped as "throw on empty output + provide an `ALLOW_EMPTY_*` env-var escape hatch" (see `empty-output-silent-degradation-2026-04-11.md`). That shape is exactly right when the caller only needs two outcomes — success (store the row) or failure (alert and drop). The moment the caller needs a *third* outcome — persist a partial record so the source document stays reachable even when its content can't be summarized — throw+env-var becomes the wrong interface. Try/catch-and-map patterns appear at every call site, the env var becomes load-bearing, and "empty but persistable" and "empty and truly broken" get conflated.

## Context

Issue #26 added an OCR fallback to the PDF text extractor built in #28. With OCR in place, most scanned PDFs now extract fine, but a small residual set still produces empty output even from the OCR path (too-dark scans, handwritten minutes, heavily skewed pages). The PRD required those residual meetings to still appear in the public UI with a link to the source PDF — the whole point of a transparency platform was to not silently hide records. The orchestrator needed to persist a meeting + document row for that case, skip summarization and fiscal extraction, and continue without surfacing an error.

The throw-based guard from 2026-04-11 could not express that. The caller would have to `try { extract() } catch { if (err.message.includes("unreadable")) { persistEmpty() } else { propagate() } }`, string-matching on the error message to distinguish the two empty cases. The env-var opt-out was also no longer useful: "accept empty extractions globally" is too coarse when the answer is now "accept empty extractions for this specific document, with a tag that the UI can render."

## Symptoms (of the wrong shape still being in place)

- Orchestrator / caller contains try/catch blocks that parse error messages or check `error instanceof SomeCustomError` to route between two "failure" paths.
- An env-var opt-out governs whether a specific category of empty output is acceptable, rather than an in-band value on the return.
- Tests for the caller need to mock *throwing* rather than returning values, even though the "empty" case is a normal outcome in the domain.
- Storage layer can't enforce an invariant like "a non-empty content column implies a specific source method" because the method isn't carried alongside the content.

## Root Cause

A silent-degradation guard's interface must match downstream's branching needs:

- **Two outcomes** (ok / fail) → throw is correct. Thrown errors are cheap to surface through existing alert paths and don't pollute the happy-path return type.
- **Three or more outcomes** (ok / partial / fail, or text-layer / ocr / unreadable, or cached / fresh / missing) → a discriminated return type is correct. The discriminant lives in the data, the caller switches on it, the storage layer asserts the invariants that connect the discriminant to the persisted shape.

The pattern is the same principle as "exceptions for exceptional cases, return values for ordinary cases." When a previously-exceptional outcome (empty text) becomes an ordinary outcome (unreadable meetings are a first-class class of record), the interface should demote that outcome from a thrown error to a return variant.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** the cost of keeping throw-based guards past their usefulness isn't immediate — it shows up as crufty try/catch-plus-string-matching patterns at call sites weeks or months later, by which point the original guard author has moved on. The second time a pipeline-shaped PRD says "persist a record of the thing that couldn't be processed," graduate the guard.

## Solution

Replace the guard's interface with a discriminated return type, and move the silent-degradation assertion from the stage itself to the persistence boundary.

**Before (throw+env-var from 2026-04-11):**

```typescript
export async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
  const text = await extractTextLayer(bytes);
  if (text.trim().length > 0) return text;

  const ocr = await ocrPdf(bytes);
  if (ocr.trim().length === 0 && !process.env.ALLOW_EMPTY_PDF_TEXT) {
    throw new Error("Both text-layer extraction and OCR returned no text...");
  }
  return ocr;
}
```

**After (tri-state + storage invariant):**

```typescript
export type ExtractResult = {
  text: string;
  method: "text-layer" | "ocr" | "unreadable";
};

export async function extractPdfText(bytes: ArrayBuffer): Promise<ExtractResult> {
  const textLayer = await extractTextLayer(bytes);
  if (textLayer.trim().length > 0) {
    return { text: textLayer, method: "text-layer" };
  }
  const ocrText = await ocrPdf(bytes);
  if (ocrText.trim().length > 0) {
    return { text: ocrText, method: "ocr" };
  }
  return { text: "", method: "unreadable" };
}

// StorageService asserts the invariant at the persistence boundary:
for (const doc of input.documents) {
  if (doc.extractionMethod !== "unreadable" && doc.rawText.trim() === "") {
    throw new Error(
      `StorageService invariant violated: document has extractionMethod='${doc.extractionMethod}' ` +
      `but empty rawText. Empty text must be tagged as 'unreadable'.`,
    );
  }
}
```

The silent-degradation *guarantee* is preserved — empty text still cannot flow to summarization without being explicitly recorded as unreadable. The guarantee moved from a throw inside the extractor (with an env-var opt-out) to a runtime assertion at the next persistence boundary (no opt-out needed; the tri-state value makes the opt-out redundant).

The `ALLOW_EMPTY_PDF_TEXT` env var goes away entirely. Smoke tests that previously needed to opt in to empty output now just observe `method === 'unreadable'` in the return.

## Prevention

**Code-level:**

- When adding a silent-degradation guard, ask: does the caller need to branch on *why* this is empty, or just handle the "not OK" case? If the former (or if you expect the former to emerge within the feature's lifetime), start with a discriminated return.
- Pair tri-state returns with a storage-boundary invariant assertion. The extractor produces the discriminant; the storage layer asserts that the discriminant and the content agree. This catches upstream drift (a new path that forgets to tag its empty case) before rows hit the DB.
- Keep test mocks aligned with the in-band shape. If `extractFoo` returns `{ text, method }`, every mock in every test should return that same shape. Tests that mock a subset of the shape paper over real coupling.

**Process-level:**

- `/write-a-prd` should ask, for pipeline stages with a content-extraction guard: "Will any meeting / row / entity need to be persisted even when the stage returns empty? If yes, specify the empty case as a discriminant on the return type, not a thrown error."
- `/prd-to-issues` should prefer a single atomic slice for "change a pipeline stage's return shape and the caller's branching" when the type change ripples across more than 3–4 files. The PRD can frame the slice as "backend type ripple + handler branch" to signal that strict per-file TDD will bundle into one commit, not many.
- `/execute` should surface this interaction explicitly: when a slice description involves changing an exported type across many files and the repo has per-edit quality gates, the atomic commit for the type ripple is the logical unit — not file-by-file sub-units. The skill's "commit after each logical unit" rule still holds; the unit is just larger than usual.

## Planning / Calibration Notes

- **What widened the work:** the `ExtractResult` type touched 8 files (extractor + its test, storage + its test, orchestrator + its test, cli, composition). The PRD's "Composite contract change ripples to orchestrator and tests" rabbit hole explicitly named this risk, and the earlier execute session paused on exactly this friction — per-edit quality gates reject intermediate non-typechecking states, so the ripple has to land in one commit. This is the expected shape, not a surprise; PRDs that include it should name it as one atomic logical unit.
- **What tightened the work:** the `extractPdfText` seam was already a function reference (not an Effect.Tag service), which meant the type refactor rippled through exactly the expected surface — the orchestrator input type, its test mocks, and the CLI composition. A deeper injection pattern (Context.Tag / Layer) would have multiplied the ripple surface.
- **Future planning adjustment:** when a PRD involves a discriminated-return refactor of an existing function-reference seam, expect the core ripple commit to be about 100–200 lines changed across 6–8 files. Tests migrate alongside. Budget as one session, not many.

## Actuals Worth Reusing

- **Comparable future work:** any pipeline stage that evolves from "ok / fail" to "ok / partial / fail" — e.g. a transcription service gaining a "speech-free audio" outcome, a crawler gaining a "redirect loop but final body cached" outcome, a summarizer gaining a "content under minimum length" outcome.
- **Reusable baseline:** the 10-line `ExtractResult` + 10-line storage-boundary invariant at `src/pipeline/services/PdfExtractor.ts` and `src/pipeline/services/StorageService.ts` (slice #30 / PR #33). The shape is: discriminated return from the stage, optional downstream fields on the persistence input, invariant assertion keyed on the discriminant.
- **Reusable pattern for test mocks:** when the repo doesn't already use `mockResolvedValueOnce` chains (as this one doesn't), sequential per-call mocking uses a closure counter inside the `it(...)` block. See `src/pipeline/orchestrator.test.ts` mixed-outcome test.

## Defect Classification

Not a defect — this compound is a pattern evolution, not a bug fix. The 2026-04-11 throw+env-var was correct for its moment. The lesson is about knowing when to graduate it.

## Key Decision

**Decision:** Apply the silent-degradation guarantee via a storage-boundary runtime assertion rather than keeping it inside the extractor as a throw.

**Rationale:** Moving the assertion to the storage layer gives every future content-producing stage the same guarantee for free, as long as they tag their output with the correct discriminant. The storage layer already owns "what goes in the DB has to make sense"; this is a natural fit. Keeping the assertion in the extractor would require every new content stage to duplicate the guard logic.

**Alternatives considered:**

- *Keep throw+env-var, let orchestrator parse error messages.* Rejected — string-matching on errors is exactly the smell this refactor eliminates.
- *Use a typed error class + `instanceof` check.* Rejected — still forces try/catch in the happy path at every call site, and test mocks get awkward ("mock a rejected promise with a specific error class"). A return variant is cleaner.
- *Use an `Either` / `Result` type from an FP library.* Considered — the project uses Effect, which has `Exit` / `Either`. Rejected here because the three outcomes are all *successful* completions in the domain (all three flow to storage); `Either` better fits true error-vs-success discrimination.

**Revisable:** Yes, if a future stage needs four+ outcomes, the flat `{ text, method }` shape may be replaced by a proper discriminated union (`{ kind: 'text-layer', text } | { kind: 'ocr', text, confidence } | { kind: 'unreadable' }`) so that outcome-specific fields don't need to be optional on the shared shape. The current flat shape is fine for three outcomes where the only differing field is `text`.

## Related

- `docs/solutions/patterns/empty-output-silent-degradation-2026-04-11.md` — the direct predecessor. Its throw+env-var prescription is preserved for the two-outcome case; this doc supersedes it for the three-or-more-outcome case.
- `docs/solutions/patterns/placeholder-stubs-in-production-paths-2026-04-10.md` — same family (silent-degradation prevention in pipeline stages).
- PR #33 — https://github.com/chrislacey89/civic-mirror/pull/33 (merged 2026-04-13)
- Issue #26 — OCR fallback for image-based eGov PDFs (parent PRD)
- Issue #30 — the tracer-bullet slice that landed this pattern

## Shelf Life

Stable — the principle holds until a fundamentally different approach to pipeline error modeling arrives (e.g. typed effect systems that make throw-vs-return an implementation detail). Review when the project moves off `Promise<T>` at pipeline seams or adopts a different discriminated-outcome convention across services.
