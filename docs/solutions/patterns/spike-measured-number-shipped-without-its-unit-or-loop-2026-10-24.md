---
date: 2026-10-24
category: patterns
problem_type: a number a spike measured ships under a different unit and stop rule than the loop that measured it, and the PR that flagged the mismatch as needing a decision before merge merged with the decision still open
components: [pipeline/checks/prePublish, pipeline/composition, spike verdicts, pre-merge decisions]
technologies: [typescript, gemini]
severity: medium
volatility: stable
---

# A spike's number ships without its unit or loop, past the review that flagged it

## Problem

A spike measured how many revision rounds the writing call needs. The slice that consumed the number shipped it in a loop that counted in a different unit and stopped for reasons the spike's loop never had, so the shipped cap could not reproduce the result it cited. The unit mismatch was not hidden. The PR that shipped it said so and marked it "needs a decision before merge", then merged with the decision still open.

## Context

#194 asked whether feeding code-check failures back to the writing call fixes them, and how many rounds to allow. Its verdict: "Cap for #202: **7**". That was the fewest rounds at which 95% of the meetings it eventually fixed were fixed. #202 shipped `DEFAULT_ROUND_CAP = 7` with the comment "Measured in #194."

The spike's harness and the shipped loop differed in three ways:

- **Unit.** The spike's round 0 was the fresh draft and rounds 1–8 were revisions (`spike.ts`, `for (round = 0; round <= MAX_ROUNDS; …)`). "Fixed at round 7" meant the seventh revision. The shipped `prePublish` counts drafts with the first included (`rounds.length < cap`), so a cap of 7 allowed six revisions. The meeting #194 fixed at its seventh revision was past the shipped cap.
- **Stop rule.** The spike's loop stopped when the draft was clean, when a writing call failed, or at the round limit. It never stopped because a round failed to improve. The shipped loop also stopped when a round failed to beat the best draft, measured in failed *gates*. A revision that cut A1's bad figures from five to one would tie on gates and stop the loop after one revision. So the meetings #194 fixed at rounds 3, 4 and 7 mostly could not be reached.
- **Prompt.** The spike's revision prompt carried the previous draft as well as the feedback (`spike.ts`, `feedbackBlock`). The shipped prompt carries only the feedback (`GeminiSummarizer.ts`).

PR #211, which shipped #202, named the unit in its Key Decisions: "`DEFAULT_ROUND_CAP = 7` here allows 6 revisions, which would have fixed 15 of #194's 16. To match #194 exactly, make it 8. **This needs a decision before merge.**" It also listed "The cap's unit" under spec drift. It merged on 2026-10-23 with the cap at 7. Its review caught the stop rule, and #212 was filed for both.

## Symptoms

- A constant's comment says "Measured in #N" and gives no unit, such as revisions or drafts, or attempts or retries.
- The spike's harness has a loop, retry or prompt structure that differs from the production code's: a different stop condition, a different comparison, a counter that starts at 0 instead of 1, or a prompt that carries different context.
- The spike's headline result (16/16 fixed by round 7) is cited for production behaviour that never re-ran the spike's cases.
- A merged PR body still carries "needs a decision before merge", or an equivalent open question, with no comment or follow-up issue recording what was decided.

## Root Cause

Two separate failures.

**The number travelled without its frame.** The verdict was written as a value ("cap 7"). The spike's counting convention lived in its harness code, and its stop rule and prompt were implicit in how the harness was written. Neither was stated beside the number. Comparing the shipped loop against the harness was left to whoever built #202. The builder did that comparison for the unit, but not for the stop rule or the prompt.

**A flagged decision had no gate.** #211's author found the unit mismatch and wrote it down as a decision the merge depended on. Nothing between that sentence and the merge button checked whether the decision had been made. The open question sat in a PR body, which no pipeline step reads at merge time, so the PR merged with the default.

The first failure was predictable from the decision to publish a bare number. The second was predictable from where the open question was written: in a place the merge step does not read.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** an open loop at merge. The review produced the right signal ("needs a decision before merge"), and nothing consumed it. A slower loop compounds it: #194's per-round output, the only data that could show what the shipped loop would have done on the same meetings, was in a scratch `.context/` directory and was gone by the time #212 needed it. Each later change to the loop moves it further from the measured conditions, and no step re-measures.

## Rule Scope

- **Applies when:** a spike, prototype or eval produces a number that becomes a production constant: a round or retry cap, a threshold, a timeout, a sample size. Production code then runs a loop, comparison or prompt that the spike's harness reimplemented rather than imported.
- **The second half applies whenever** a PR body records a decision that must be made before merge, whatever the subject.
- **Does not apply when:** the spike ran the production code path itself (imported the real loop, checks and prompt), so unit, stop rule and prompt cannot differ. In that case only the inputs need to match.
- **Sibling docs:** `llm-list-extraction-single-draw-mistaken-for-baseline-2026-10-07.md` is about the inputs and draws behind a baseline, not the conditions it was measured under. `llm-rubric-asks-for-a-measurement-the-input-lacks-2026-10-07.md` is about a measurement the input cannot support. Neither is this pattern: here the measurement was sound and the use of it changed its meaning.

## Solution

#212 (PR #217) moved the shipped loop toward #194's conditions, and wrote down where it still differs:

- **Cap.** It is 8: the first draft plus seven revisions.
- **Ties.** A round that ties the best draft on failed gates and style score replaces the best and the loop keeps revising. The loop stops on a worse round: more failed gates, a lower style score at equal gates, or fewer grounded figures.
- **Repeated feedback.** It also stops when a round's feedback is identical to the best draft's. The prompt carries only the feedback, so the next call would repeat the last one. #194's loop had neither this stop nor the worse-round stop. Its prompt carried the previous draft, so its feedback never fully determined the next call.
- **Statements.** The loop's stop rules are stated once, in the `prePublish` docstring. The cap's comment states its unit and points there.

#213 re-measures the shipped loop against #194's meetings, including whether these stops cut slow meetings off.

## Prevention

**Code-level:** a constant taken from a measurement says, in its comment, what it counts (with the first attempt included or not) and where its measurement conditions are recorded. A comment that gives the issue number alone is not enough.

**Process-level:**

- A spike verdict that recommends a number states, beside it, the unit, the harness's stop rule, and what its prompt or input carried. Example: "7 revisions after the first draft, under a loop that stops only when clean, revising from the previous draft plus feedback".
- The slice that consumes the number compares the production loop against those conditions before shipping, and records each difference as a known-weak spot or a follow-up issue.
- A PR body that says a decision is needed before merge is not mergeable until the decision is recorded: as an edit to the PR, a comment, or a follow-up issue linked from the body. `/pre-merge`'s reviewer and `/closeout` should look for open decision lines in the body before merging.
- Keep a spike's raw per-round output somewhere durable, such as an issue attachment or a committed fixture, whenever a later slice will consume its numbers. Scratch `.context/` output cannot answer the follow-up question.

## Planning / Calibration Notes

- **Future planning adjustment:** when `/prd-to-issues` writes a slice that consumes a spike's number, its Context block should quote the unit, the harness's stop rule and its prompt shape, not only the value.

## Key Decision

**Decision:** keep revising on a tie, stop on a worse round or on repeated feedback, and set the cap to 8, not 7.
**Rationale:** the tie rule and the cap move the shipped loop toward the conditions #194 measured. The repeated-feedback stop departs from them on purpose, because a repeated feedback-only prompt is likely to repeat its output, although temperature 0 does not guarantee that. Re-measuring under the old stop rule would have needed a new spike, and the old spike's raw data no longer existed.
**Alternatives considered:** count failed items inside gates; keep the old stop rule and re-measure the cap.
**Revisable:** yes. When #213 re-measures the shipped loop, its per-round counts decide whether the worse-round and repeated-feedback stops cut slow meetings off, and what the cap should be.

## Related

- #194 (spike verdict), #202 (loop as first shipped), PR #211 (shipped #202; flagged the unit), #212 (this fix), PR #217, #213 (re-measurement)

## Shelf Life

Evergreen as a principle. The specific numbers expire when #213 re-measures the loop as shipped.
