---
date: 2026-10-25
category: patterns
problem_type: a prompt rule written to tell the model what a code check enforces either under-claims or over-promises, because the check accepts an irregular set the model cannot predict
components: [pipeline, summarization, pre-publish-check, figures-check, prompt]
technologies: [gemini, vitest, typescript]
severity: medium
volatility: stable
---

# A prompt rule that mirrors a code check has to be stricter than the check

## Problem

The writing prompt tells the writer what the A1 figures check will hold it to. Three wordings of that sentence were tried in one PR (see Context). No test could tell the three apart.

## Context

PR #219 (slice #214 of #193) made one sentence, `LEDGER_FIGURE_RULE` in `src/pipeline/checks/figures.ts`, the single statement of when a ledger figure may appear in the prose. Rule 11 and the FEEDBACK block both interpolate it. The sentence went through three wordings across two review rounds:

1. **"writes exactly"** (`453ff93`). Stricter than A1, which compares figures by value, so "$258,400" passes against a source's "$258.400.00". Review said the writer was told to drop figures A1 accepts.
2. **"the same amount however it is written"** (`59b3e54`). Matched A1's by-value comparison, but promised more than A1 accepts. It also contradicted rule 11's "garbled form" clause, which is the case #214 was meant to fix.
3. **"as a clear numeral, even if punctuated differently … left out … when a source gives it only in words or inside garbled text"** (`14068ef`).

Each round's fix also created the next round's finding. For three of the five fixes, a mutation breaker still passed every test, and two of the five introduced new findings.

## Symptoms

- A review finding says the prompt "under-claims" a check, and the fix for it draws an "over-promises" finding in the next round, or the other way round.
- Rewriting the rule to mean the opposite leaves every test green. Here a breaker inverted `LEDGER_FIGURE_RULE` and all 778 pipeline tests passed, and restoring the "however it is written" wording also passed.

## Root Cause

A code check like A1 does not accept a set that can be stated in a sentence. Its tokenizer, spelled-number parser and exclusions decide case by case, so "what A1 accepts" can only be described exactly by the code. A sentence aimed at that set misses it somewhere. If it claims less, the writer drops figures it could keep, which is the under-claiming #193 tracks. If it claims more, the writer keeps figures A1 then holds, and the whole summary goes back for a revision.

The two failures cost different amounts. A dropped figure costs one number. A held summary costs a revision round, or the meeting doesn't publish.

So the sentence should miss only on the cheap side, which means keeping fewer figures than A1 accepts. That is not a licence to be as strict as possible. A1 compares figures by value, so punctuation is something the writer can predict and the rule should not ask for it ("writes exactly" did, and so dropped figures A1 accepts). Be stricter only where the tokenizer is unpredictable, such as a figure given in words or inside garbled text. The shipped wording does not fully meet that goal. A1 fails "$45,000" when a source writes "$41,700-$45,000" with no spaces around the hyphen, because `wholeFigures` skips any figure right after a hyphen, and the sentence still tells the writer to keep it (tracked on #220).

The second root cause is that a test cannot read what an English sentence means. What it can do is pin the check's behaviour next to the constant. `figures.test.ts` runs A1 on the case the rule governs: a ledger-only figure fails, and the same draft passes once the figure is dropped or a source writes it. That catches a change to A1. It does not catch a reworded sentence, and #220 R1 records that as a known limit.

## Learning Level

- **Level:** Pattern. This is the third time a check and the words describing it to the model drifted apart in this pipeline (the `RULES` titles in `feedback.ts` drifting from the rubric, fixed in the same PR, and the ledger-outranks wording this PR removed). It is the first time the drift came from trying to match the check exactly.
- **Feedback loop or delay:** review-and-fix rounds pull the wording toward the check from whichever side the last finding named, so it oscillates. Nothing mechanical shows which side of the check a sentence falls on, so each round re-runs the same argument.

## Rule Scope

- **Applies when:** a prompt tells a model what a code check will enforce on its output, and the check's acceptance comes from parsing (tokenizing, number parsing, exclusions) that the model can't run. That covers every slice of #193 that pairs a check with a prompt rule.
- **Inverts or does not apply when:** the check accepts a set a sentence can state exactly. A closed list, a fixed format or an enum can be stated in full, so match the check and derive the sentence from the same data. It also inverts when over-claiming is the cheap side, i.e. when a rejected output costs less than an omission (for example, a retry that is free and an omission that is published).
- **Sibling docs:** `check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md` (choose the rule that fails toward the cheap direction; same cost reasoning, applied to the check rather than the prompt); `grounding-check-exclusion-trades-false-holds-for-false-passes-2026-10-21.md` (A1's exclusions, which are why A1's accepted set is irregular); `writing-rules-in-an-extraction-prompt-leak-into-the-extraction-2026-10-09.md` (use invented examples in prompt rules, which R4 here enforced).

## Solution

- Keep the rule as one constant next to the check, interpolated everywhere the model is told it. Don't keep a hand-written second copy. The revision instruction at `GeminiSummarizer.ts:214` is still one, and #220 tracks it (comment of 2026-10-25).
- Word the rule to cover a subset of what the check accepts.
- Pin the check's behaviour next to the constant on the case the rule governs. Don't pin the sentence's wording. A wording test only checks that the sentence exists, not that it is true.
- Accept that the sentence's meaning cannot be tested. Name test blocks so they claim only what they check, and write acceptance criteria that don't promise "a test fails if they diverge" for prose.
- Use an invented figure in the rule's example ("$41.700.00" for $41,700), not one from a real meeting.

## Prevention

**Code-level:** the behaviour block in `figures.test.ts` beside `LEDGER_FIGURE_RULE`, and the "states the rule once / no outranking wording" tests in `GeminiSummarizer.test.ts`. Neither catches a reworded sentence. Nothing in code can.

**Process-level:** when a `/write-a-prd` or `/prd-to-issues` acceptance criterion says a test will keep a prompt sentence in line with a check, rewrite it before execution: "the check's behaviour on the governed case is pinned beside the constant; the sentence is reviewed, not tested". When a review finding says a prompt rule under-claims a check, ask which side is cheap before moving the wording toward the check.

Clustering judgment: the nearest entry is `check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md`, which shares the cost argument. That entry is about which output the model gives deciding a check's verdict. This one is about describing a check to the model in words. They are different patterns, so Phase 4's mechanism requirement does not fire.

## Planning / Calibration Notes

- **What widened the work:** #214 was scoped as removing a contradiction (one sentence, interpolated twice). Two extra review rounds and five fix commits went into the wording of that one sentence, plus a follow-up issue (#220) for four gaps that could not close.
- **What tightened the work:** a breaker per finding (mutate, run the suite) showed at once which fixes were pinned and which were only worded. The read-only `summarize:recheck` meetings confirmed the ledger did not move.
- **Future planning adjustment:** for each remaining #193 slice that adds a check with a matching prompt rule, plan the rule as "stricter than the check, gap documented, behaviour pinned" from the start, and budget one review round for the sentence rather than letting it go around in fix rounds.

## Key Decision

**Decision:** The rule keeps a ledger figure only when a source writes it as a clear numeral, punctuation aside, and leaves it out when sources give it only in words or garbled; stricter than A1 is the goal, not a guarantee, and Root Cause says how it relates to A1.
**Rationale:** the writer can't predict A1's tokenizer. Missing on the strict side costs one figure, and missing on the loose side holds the summary.
**Alternatives considered:** "writes exactly" (under-claims by-value matches); "however it is written" (over-promises spelled-out and glued figures A1 rejects); teaching A1 to accept ledger figures (rejected, because A1 is the site's "every figure traceable to a source" promise).
**Revisable:** yes, if A1's accepted set becomes something a sentence can state, e.g. a normalizer that exposes the exact forms it accepts.

## Related

- PR #219, slice #214, PRD #193
- #220: the gaps this left open (R1 sentence untestable, R3 nothing pins "stricter", R6 rule 12 and rubric "as the record writes them", R7 thin example coverage; plus two gaps added in a later comment: the revision instruction in `GeminiSummarizer.ts` is a hand-written second copy of the rule, and the rule still over-promises on unspaced hyphenated ranges like "$41,700-$45,000")

## Shelf Life

This applies while A1 accepts an irregular set that a sentence can't state. If the prompt rule is ever generated from A1's own acceptance data, or the writer can call A1 before submitting, this entry no longer applies.
