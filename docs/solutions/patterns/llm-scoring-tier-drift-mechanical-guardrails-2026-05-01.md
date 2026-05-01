---
date: 2026-05-01
category: patterns
problem_type: probabilistic LLM emissions on load-bearing fields
components: [pipeline, drama-detection, ai-boundary, storage]
technologies: [gemini, ai-sdk, effect, llm-judging]
severity: high
volatility: stable
---

# LLM scoring drifts across re-runs; mechanical guardrails own the load-bearing field

## Problem

When an LLM is asked to produce both a *score* and a *tier label* derived from that score, two re-runs of the same input can produce materially different tiers — even with low temperature, native thinking budgets, and a locked prompt. If the tier label is the load-bearing field for downstream behavior (auto-publishing, gating, tier-based routing), trusting the LLM's emitted label means downstream behavior also drifts. The fix is to make the mechanical derivation the source of truth and treat the LLM's label as a hint that gets overridden when it disagrees.

## Context

Drama Watch v1 asks Gemini 2.5 Flash to score seven categories of meeting friction (0–3 each, sum range 0–21) and emit a tier (`routine`/`bumpy`/`heated`/`off-the-rails`) where the tier is mechanically derived from the sum (`mapSumToLevel(sum)`). The tier gates the auto-publish rule: `routine`/`bumpy`/`heated` go live at insert time, `off-the-rails` queues for manual review.

Two real-API runs against the same RBB hiring transcript with `prompt_version="v1"`, `model="gemini-2.5-flash"`, and `thinkingBudget: 4096`:

| Run | Sum | LLM-emitted level | mapSumToLevel(sum) |
|-----|-----|-------------------|--------------------|
| A | 18 | `off-the-rails` | `off-the-rails` |
| B | 11 | `heated` | `bumpy` |

That's a 7-point swing on identical input. Run A would have queued for manual review; Run B auto-published. Without a mechanical override, the same meeting could have either outcome depending on which side of an LLM coin flip we're on.

## Symptoms

- Same input, same model, same prompt version → different scores and tier classifications across runs.
- The LLM's emitted tier label disagrees with the mechanical sum-to-tier mapping (LLM says "heated" when sum is 11, which `mapSumToLevel` correctly maps to "bumpy").
- Storage-boundary log: `[drama] level override: LLM emitted "X", mapSumToLevel(N) = "Y"`.
- Sibling effect: hand-graded eval set drift across runs of the same transcript — a category may score 2 on Monday and 0 on Tuesday for reasons no prompt change can pin down.

## Root Cause

LLM token sampling is non-deterministic by design (even at temperature 0, scheduling and quantization create observable variance). The model is also asked to do two arithmetic-like operations that probabilistic generation handles poorly: sum seven small integers, then map the sum into one of four buckets. The score field is *easier* to get right (it's anchored on category-specific 0–3 rubric language); the tier label is *harder* because it requires an internal computation the model is being trained to *generate* rather than *execute*.

Trusting the LLM's emitted tier as the source of truth conflates two different kinds of output:

- **Judgment fields** (score, headline, narrative, evidence quotes): the LLM is the right tool — these require pattern recognition over a long transcript.
- **Mechanical fields** (sum, tier, derived flags): the LLM is the wrong tool — these are pure functions of the judgment fields and should be computed deterministically.

## Learning Level

- **Level:** Pattern. Recurs whenever an LLM is asked to emit both a score-like field and a derived/computed field over the same response.
- **Feedback loop or delay:** Delayed effect with low signal density. A single wrong tier looks like a normal LLM output; the drift only becomes visible after multiple runs of the same input or after operators notice "the same meeting got published differently last week."

## Rule Scope

- **Applies when:** The LLM's structured output contains a *load-bearing* field that is mechanically derivable from other fields in the same response. "Load-bearing" means downstream code reads it to make a decision (gate publication, route to a queue, classify severity, count toward a metric).
- **Inverts or does not apply when:** The derived field is *advisory only* — e.g., a UI hint, a confidence summary, a human-readable label rendered next to the underlying numbers. In that case the LLM's emission can stand because nothing branches on it.
- **Sibling docs:**
  - `docs/solutions/patterns/tri-state-return-for-pipeline-outcomes-2026-04-13.md` — same shape (in-band discriminant + variant payload). The drama assessment is a tri-state-style return where `level` is the discriminant and `category_scores` is the payload; this doc adds the "the discriminant must be mechanically derived, not LLM-emitted" rule on top of tri-state.
  - `docs/solutions/integration-issues/gemini-response-schema-numeric-enum-rejection-2026-05-01.md` — adjacent issue on the same boundary. The score field this pattern protects is also where Gemini's enum constraint bit.

## Solution

Apply the mechanical override at every layer that touches the load-bearing field. Defense-in-depth, because the cheapest guardrail to skip is the one that's never been wrong yet.

**Two-layer override:**

1. **Service layer** (`DramaDetectionService.ts`): after the LLM call returns and before the result leaves the boundary, recompute the derived field from the source-of-truth fields. Log mismatches as prompt-iteration signal.

   ```typescript
   function recomputeLevelFromScores(
     assessment: DramaAssessmentOutput,
   ): DramaAssessmentOutput {
     const sum = sumCategoryScores(assessment.category_scores);
     const computed = mapSumToLevel(sum);
     if (computed === assessment.level) return assessment;
     console.warn(
       `[drama] level override: LLM emitted "${assessment.level}", ` +
         `mapSumToLevel(${sum}) = "${computed}"`,
     );
     return { ...assessment, level: computed };
   }
   ```

2. **Storage boundary** (`StorageService.ts`): repeat the invariant check on insert. The service-layer override protects the "passed through `detect()`" path; the storage-boundary override protects every path, including future direct callers and any test that constructs an assessment by hand.

   ```typescript
   const computedLevel = mapSumToLevel(total);
   let level = input.level;
   if (computedLevel !== level) {
     console.warn(`[drama-storage] level override on insert: …`);
     level = computedLevel;
   }
   ```

The duplication is intentional and worth a comment at the storage site so future readers don't dedup it away.

## Prevention

**Code-level:**

- For any LLM-emitted derived field, write the mechanical computation as a pure function (e.g., `mapSumToLevel(sum)`) and apply it as the source of truth at the storage or boundary layer. Do not trust the LLM's emission.
- Log overrides at warn level so prompt iteration has a visible signal when drift accumulates.
- Test: a unit test where the LLM-emitted tier disagrees with the score sum and the result is the computed tier, not the emitted one. (See `DramaDetectionService.test.ts:120–135` and `StorageService.test.ts:756–786` for the canonical shapes.)

**Process-level:**

- Add to `/research`'s Phase 1 LLM-feature scan: identify which response fields are load-bearing for downstream behavior and which are derivable from other fields. Flag derivable load-bearing fields as candidates for mechanical override before shaping.
- Add to `/write-a-prd`'s "Don't Hand-Roll" scan: "If the LLM emits both a score and a derived label, the storage boundary must enforce `label === f(score)` and override-on-mismatch."
- Add to `/qa` heuristics: when an LLM-judgment feature is the subject of a bug report, re-run the same input 3–5 times before accepting the bug as a defect. Drift across runs is its own defect class, separate from "the model gave the wrong answer once."

## Planning / Calibration Notes

- **What widened the work:** None directly — the override pattern was already in the PRD's boundary map. What this *will* widen: slice #5 (methodology + prompt iteration) needs to budget for hand-graded eval across multiple runs of the same transcript, not just single-shot scoring.
- **What tightened the work:** The PRD baked in the `mapSumToLevel` invariant and the override-with-log pattern explicitly, so first-run drift surfaced clean override logs rather than silently corrupted data. This is the win — without the pattern, the calibration data wouldn't exist.
- **Future planning adjustment:** When `/research` covers an LLM-judgment feature, surface "expected re-run drift" as an explicit unknown alongside "expected response latency." Run-to-run variance is a first-class characteristic of the feature, not an edge case.

## Actuals Worth Reusing

- **Comparable future work:** Any LLM-as-judge feature where a tier, severity, classification, or gating flag is part of the response. Civic Mirror examples on the horizon: severity scoring of fiscal-decision opacity, ranking of which meetings are "newsworthy," confidence calibration on summaries.
- **Reusable baseline:** Expect ≥10% absolute tier disagreement between re-runs on borderline inputs (sum-near-tier-boundary cases). Budget hand-graded eval in pairs (same input, two runs) to surface drift, not single-shot.

## Defect Classification

- **Origin phase:** Design success, not a defect. The pattern was anticipated in the PRD and shipped correctly.
- **Fix type:** N/A. This compound captures the pattern that *prevented* the defect class — future work should adopt it, not avoid it.

## Key Decision

**Decision:** Mechanical sum-to-tier mapping is the source of truth for the `level` field; LLM emissions are advisory and overridden on mismatch.

**Rationale:** LLM token-sampling drift makes the emitted tier non-deterministic across runs of the same input; tier is load-bearing for the auto-publish rule; arithmetic over small integers is a domain where deterministic functions strictly dominate generative inference.

**Alternatives considered:**

- **Trust the LLM, retry on mismatch.** Rejected: doesn't converge — the next run can disagree differently. Burns API calls. Doesn't address the fundamental drift.
- **Lower the temperature further / pin random seed.** Rejected: scheduling and quantization variance are not seed-controlled. Drift remains.
- **Make the LLM output only the scores, compute tier client-side.** Considered. Roughly equivalent in correctness; the chosen design lets the LLM emit a tier so its reasoning shows the framing decision (procedural-theater pattern, etc.) for prompt iteration. The override gives us the safety without losing the diagnostic.

**Revisable:** No, in the sense that "trust the LLM emission" is never safe for load-bearing derived fields. Yes in the sense that *which* layer applies the override is a design choice — single-layer is acceptable if the override layer is the only consumer.

## Related

- PR: https://github.com/chrislacey89/civic-mirror/pull/65
- Sibling: `docs/solutions/patterns/tri-state-return-for-pipeline-outcomes-2026-04-13.md`
- Adjacent: `docs/solutions/integration-issues/gemini-response-schema-numeric-enum-rejection-2026-05-01.md`
- Calibration evidence: PR #65 commit `4241426`'s body — two runs, sum=18 and sum=11 on the same RBB hiring transcript

## Shelf Life

Evergreen for the duration that LLM token sampling is non-deterministic — i.e., for the foreseeable future of generative AI. Even when models become substantially more reliable on arithmetic-like derivations, "trust the LLM for load-bearing computed fields" remains the wrong posture; the cost of the deterministic override is one pure function and one log line. If a future provider ships true determinism guarantees on a specific class of derived fields, revisit selectively.
