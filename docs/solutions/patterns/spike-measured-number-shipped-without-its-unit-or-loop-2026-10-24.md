---
date: 2026-10-24
category: patterns
problem_type: a number a spike measured is shipped into code that counts in a different unit and runs under a different stop rule than the loop that measured it
components: [pipeline/checks/prePublish, pipeline/composition, spike verdicts]
technologies: [typescript, gemini]
severity: medium
volatility: stable
---

# A spike's number is shipped without the unit it counted or the loop it ran under

## Problem

A spike measured a parameter: how many revision rounds the writing call needs. The slice that consumed it copied the number but not its unit or the conditions it was measured under. The shipped cap counted something else and stopped for reasons the spike's loop never had, so it could not reproduce the result it cited.

## Context

#194 asked whether feeding code-check failures back to the writing call fixes them, and how many rounds to allow. Its verdict: "Cap for #202: **7**". That was the fewest rounds at which 95% of the meetings it eventually fixed were fixed. #202 shipped `DEFAULT_ROUND_CAP = 7` with the comment "Measured in #194."

Two things differed between the spike and the shipped loop, and neither was visible from the number:

- **Unit.** The spike's round 0 was the fresh draft and rounds 1–8 were revisions (`spike.ts`, `for (round = 0; round <= MAX_ROUNDS; …)`). "Fixed at round 7" meant the seventh revision. The shipped `prePublish` counts drafts with the first included (`rounds.length < cap`), so a cap of 7 allowed six revisions. The meeting #194 fixed at its seventh revision was past the shipped cap.
- **Stop rule.** The spike's loop stopped only when the draft was clean or at the round limit. It counted failed *items*, not failed gates. The shipped loop also stopped when a round failed to beat the best draft, which it measured in failed *gates*. A draft that cut A1's bad figures from five to one tied on gates and stopped after one revision. So the meetings #194 fixed at rounds 3, 4 and 7 mostly could not be reached.

The review of #202 (in #211) caught the stop rule (#212). PR #211's Key Decisions flagged the cap's unit and left it for a decision before merge (`gh pr view 211`).

## Symptoms

- A constant's comment says "Measured in #N" and gives no unit, such as revisions or drafts, or attempts or retries.
- The spike's harness has a loop or retry structure that differs from the production code's: a different stop condition, a different comparison, or a counter that starts at 0 instead of 1.
- The spike's headline result (16/16 fixed by round 7) is cited for production behaviour that never re-ran the spike's cases.

## Root Cause

The verdict was written as a value ("cap 7"), and a value travels without its frame. The spike's counting convention lived in its harness code. Its stop rule was implicit in how the loop was written, not stated in the verdict. #202 was built from the verdict, not the harness.

The outcome was predictable from the decision: when a slice consumes a measured number, the number is only as valid as the match between the conditions it was measured under and the conditions it is used under.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** PR #211's Key Decisions flagged the cap's unit and left it for a decision before merge (`gh pr view 211`). #194's per-round output, the only data that could show what the shipped loop would have done on the same meetings, was in a scratch `.context/` directory and was gone by the time #212 needed it. Each later change to the loop (#212's tie rule, #205's judge) moves it further from the measured conditions, and no step re-measures.

## Rule Scope

- **Applies when:** a spike, prototype or eval produces a number that becomes a production constant: a round or retry cap, a threshold, a timeout, a sample size. Production code then runs a loop or comparison that the spike's harness reimplemented rather than imported.
- **Does not apply when:** the spike ran the production code path itself (imported the real loop and real checks), so unit and stop rule cannot differ. In that case only the inputs need to match.
- **Sibling docs:** `llm-list-extraction-single-draw-mistaken-for-baseline-2026-10-07.md` is about the inputs and draws behind a baseline, not the conditions it was measured under. `llm-rubric-asks-for-a-measurement-the-input-lacks-2026-10-07.md` is about a measurement the input cannot support. Neither is this pattern: here the measurement was sound and the use of it changed its meaning.

## Solution

#212 (PR #217):

- the loop stops only on a worse round, so a tie keeps revising, matching the spike's never-stop-early loop more closely;
- the cap is 8, the first draft plus seven revisions;
- the comment states the unit and the source:

```typescript
/**
 * How many drafts the writing call may write for a meeting, the first
 * included, before the best is kept: the first draft and up to seven
 * revisions. …
 * Measured in #194, with a loop that revised until the draft was clean:
 * seven revisions is the fewest at which 95% of the meetings it eventually
 * fixed were fixed, across 36 meetings and two runs.
 */
const DEFAULT_ROUND_CAP = 8;
```

The remaining difference, that the shipped loop still stops on a worse round and the spike's did not, is stated in PR #217's known-weak spots. #213 is the re-measurement against the shipped loop.

## Prevention

**Code-level:** a constant taken from a measurement says, in its comment, what it counts (with the first attempt included or not) and the conditions it was measured under. A comment that gives the issue number alone is not enough.

**Process-level:**

- A spike verdict that recommends a number states the unit and the harness's stop or comparison rule next to it. Example: "7 revisions after the first draft, under a loop that stops only when clean".
- The slice that consumes the number checks the production loop against those conditions before shipping, not after.
- Keep a spike's raw per-round output somewhere durable, such as an issue attachment or a committed fixture, whenever a later slice will consume its numbers. Scratch `.context/` output cannot answer the follow-up question.

## Planning / Calibration Notes

- **Future planning adjustment:** when `/prd-to-issues` writes a slice that consumes a spike's number, its Context block should quote the unit and the harness's stop rule, not only the value.

## Key Decision

**Decision:** keep revising on a tie and stop only on a worse round, and set the cap to 8, not 7.
**Rationale:** both move the shipped loop toward the conditions #194 measured. Re-measuring under the old stop rule would need a new spike, and the old spike's raw data no longer existed.
**Alternatives considered:** count failed items inside gates (still stops when a round fixes nothing, which #194's loop never did); keep the stop rule and re-measure the cap.
**Revisable:** yes. When #213 re-measures the shipped loop, its per-round counts decide whether the worse-round stop cuts slow meetings off, and what the cap should be.

## Related

- #194 (spike verdict), #202 (loop as first shipped), #211 (review), #212 (this fix), PR #217, #213 (re-measurement)

## Shelf Life

Evergreen as a principle. The specific numbers expire when #213 re-measures the loop as shipped.
