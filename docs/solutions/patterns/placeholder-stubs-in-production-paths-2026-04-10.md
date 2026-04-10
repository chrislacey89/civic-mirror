---
date: 2026-04-10
category: patterns
problem_type: silent production degradation
components: [pipeline, cli]
technologies: [effect]
severity: high
volatility: evergreen
---

# Placeholder stubs wired into production default paths

## Problem

When a slice ships with a placeholder function that a follow-up slice will replace, wiring that placeholder as the *default* for its production code path creates a silent footgun: the production code path succeeds loudly, but the output is garbage. Dry-run verification can't catch it, because dry-run usually short-circuits before the code path that would reveal the problem.

## Context

Issue #8 delivered an orchestrator + CLI that composes a 5-stage pipeline: scrape → extract → summarize → store. The "extract" stage is PDF text extraction, which was explicitly scoped out — a follow-up slice will wire a real extractor (pdf-parse / unpdf). In the meantime, `composition.ts` wires `placeholderPdfExtract` into the CLI:

```typescript
async function placeholderPdfExtract(bytes: ArrayBuffer): Promise<string> {
	return `[PDF placeholder — ${bytes.byteLength} bytes; install a PDF extractor to see real text]`;
}
```

and then, unconditionally, in the CLI's runtime construction:

```typescript
yield* runPipeline({
	bodies,
	crawlDelayMs: skipCrawlDelay ? 0 : 300_000,
	extractPdfText: placeholderPdfExtract,  // <-- always used, dry-run or not
	dryRun,
}).pipe(Effect.provide(layers));
```

Verification happened via `pnpm pipeline:dry --body ellettsville-town-council`, which reported `processed=25 errors=0`. Green. The dry-run short-circuits before `storeMeeting`, so the placeholder text never hits the DB — but it *does* flow through real Gemini API calls, and the `errors=0` count measures "did the pipeline reach the end of the loop," not "did the output make sense."

A non-dry `pnpm pipeline run` would have:

1. Scraped 25 eGov listings (real)
2. Downloaded 25 real PDF bytes
3. Called `placeholderPdfExtract` 25 times, getting back `"[PDF placeholder — 73241 bytes; install a PDF extractor to see real text]"`
4. Summarized each placeholder via real Gemini ($$)
5. Gemini would return empty `fiscalDecisions: []` because no `$` amounts appear in the placeholder
6. `verifyAmounts` would run against an empty array (no-op)
7. `storeMeeting` would persist 25 meetings with empty summaries and zero fiscal decisions
8. CLI would print `[pipeline] done: processed=25 errors=0` — indistinguishable from a successful real run

## Symptoms

- Dry-run succeeds with a non-zero `processed` count
- Non-dry run would succeed with the same `processed` count
- Output data is silently garbage: empty `fiscalDecisions`, meaningless `prose`, `rawText` that is just a placeholder marker
- Nothing logs "warning: using placeholder extractor"
- The CLI reports the same "done" message whether the pipeline extracted real content or placeholder strings

## Root Cause

"Placeholder for follow-up slice" is not a safe default value when the caller is a trust boundary. The CLI consumer doesn't know `extractPdfText` is a stub — its name says "extract PDF text" and its type signature says "ArrayBuffer in, text out." The function lies about its semantics.

More generally: **dry-run success ≠ real-run success**. Dry-run checks that the pipeline *reaches* storage; it does not check that the data *arriving at* storage is correct. Any problem upstream of storage that produces structurally-valid garbage is invisible to dry-run.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** The feedback loop here is from "production run" to "operator notices the data is garbage." If the operator trusts the `done: processed=25 errors=0` signal, the delay could be days or weeks before a human opens the frontend and sees empty summaries — at which point 25 meetings have been persisted with garbage data, real Gemini API credits have been spent, and the fix requires both a PDF extractor AND a data backfill to correct the corrupted rows.

## Solution

Three options, in increasing order of assertiveness:

**1. Fail-fast placeholder.** Change `placeholderPdfExtract` to throw unless an explicit `ALLOW_PLACEHOLDER_PDF=1` env var is set:

```typescript
async function placeholderPdfExtract(bytes: ArrayBuffer): Promise<string> {
	if (!process.env.ALLOW_PLACEHOLDER_PDF) {
		throw new Error(
			"placeholderPdfExtract called in a non-opt-in context. " +
				"Wire a real PDF extractor (pdf-parse/unpdf) in composition.ts, " +
				"or set ALLOW_PLACEHOLDER_PDF=1 to explicitly accept garbage output.",
		);
	}
	return `[PDF placeholder — ${bytes.byteLength} bytes]`;
}
```

This guarantees that a non-dry run using the default CLI path either runs with a real extractor or crashes loudly. Dry-run with the env var set still works for smoke testing.

**2. Dry-run-only binding.** Don't wire the placeholder at all in the production layer; only wire it when `--dry-run` is passed:

```typescript
extractPdfText: dryRun ? placeholderPdfExtract : requireRealExtractor(),
```

Where `requireRealExtractor` throws at layer-construction time if no real extractor is wired. This forces the follow-up slice to actually land before any non-dry run is possible.

**3. Remove the placeholder entirely, gate the slice on the follow-up.** The strictest option: don't merge the orchestrator slice until a real PDF extractor exists. Makes this slice larger but eliminates the silent-degradation window completely.

For issue #8 the pragmatic choice is option 1, because the follow-up slice is genuinely small and the operator is the same human as the developer. For a larger team, option 2 or 3 is safer.

## Prevention

**Code-level:**

- Any function named or documented as a placeholder/stub/TODO should fail-fast unless explicitly opted into. Don't trust that future you will remember to replace it before running in production.
- Dry-run implementations should never be the default runtime binding for a function the production code path also calls. Either both paths use the same function or they're bound by different code paths — never "this stub happens to work in both contexts because one of the contexts doesn't look at the output."
- Consider a `Stub<T>` phantom type or runtime marker so any code that accepts `extractPdfText: (bytes) => Promise<string>` can refuse to accept a `Stub`-marked function outside dry-run mode.

**Process-level:**

- `/execute` Step 4 verification ladder already has a Tier 2.5 "Runtime Startup Verification." Add a Tier 2.6 "Non-dry path simulation" for CLI tools: without actually running non-dry, statically confirm that the default runtime bindings either (a) match the names they claim or (b) throw if called in the non-dry path. For Effect pipelines specifically: confirm that every `extractX` / `storeX` / `sendX` function in the default `buildProductionLayers` output isn't trivially a stub.
- `/pre-merge` Dimension 7 (Runtime Initialization) should explicitly flag "placeholder function wired as production default" as a Concern pattern, not a Suggestion. The PR #23 review called this out as a Suggestion; it probably should have been a Concern.
- When a slice ships with a planned follow-up that will replace a stub, the PR description should link to the follow-up issue *and* confirm that the stub either fails-fast or is gated behind an explicit opt-in. "We'll wire it up next slice" is not enough.

## Key Decision

**Decision:** PR #23 shipped with `placeholderPdfExtract` as a silent default. The follow-up slice will wire a real extractor.

**Rationale:** The slice's acceptance criteria were about orchestration, not PDF parsing. Adding a PDF library mid-slice would have inflated scope. Dry-run mode is safe, and the human operator is aware of the limitation.

**Alternatives considered:** Fail-fast placeholder (option 1 above). Rejected at the time for speed; should be applied in a follow-up before the next non-dry run.

**Revisable:** Yes — apply the fail-fast pattern as soon as a non-dry run is plausible, or before merging the real-extractor follow-up slice.

## Planning / Calibration Notes

- **What widened the work:** the pre-merge review had to explicitly reason about dry-run vs non-dry semantics to catch this. Without that review, the footgun would have shipped.
- **Future planning adjustment:** when `/write-a-prd` shapes a slice that will defer work to a follow-up, the PRD should explicitly specify whether the deferred work is "stubbed safely" or "wired as default." The default should be safe; anything else should be an explicit, reviewed decision.

## Related

- PR #23 — https://github.com/chrislacey89/civic-mirror/pull/23 (pre-merge review flagged as Dimension 7 Suggestion)
- Follow-up: real PDF extractor (pdf-parse or unpdf)

## Shelf Life

Evergreen — applies to any slice that defers production-critical code to a follow-up while shipping a stub. The specific PDF-extractor case ends when the follow-up slice lands.
