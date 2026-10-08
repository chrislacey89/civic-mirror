---
date: 2026-10-08
category: patterns
problem_type: a mechanical check on model output whose verdict depends on which of several plausible outputs the model happened to give
components: [pipeline, summarization, ai-boundary, ocr]
technologies: [gemini, ai-sdk, tesseract, effect]
severity: high
volatility: stable
---

# A check that compares the model's output with its source can pass because of what the model wrote, not because of what the source says

## Problem

A guard that asks "is the model's value present in the source text?" looks like a check on the source. It is a check on the pair. When the source is damaged, the model can return more than one plausible value for it, and some of those are literally present in the damaged text. The guard then passes or fails according to which one the model returned, and that can change with any prompt edit.

## Context

Every Town Council document in production is a scan read by OCR. On the 2025-05-27 minutes the OCR destroyed the paving bid: the text reads "E & B Paving for fpaa-215.10". The video states $244,215.10 twice and the 2025-08-11 minutes confirm it.

#179 added a readability check: the documents govern a figure only when the figure can be found in them; otherwise the video's figure is used. Over one afternoon the documents-only model call returned two different values for that one passage:

| Model returned | In the text? | Check said | Stored |
|---|---|---|---|
| "$215,215.10", a reconstruction | no | unread | $244,215.10 from the video |
| "$215.10", the legible tail | yes, as "fpaa-215.10" | read | $215.10 |

The second row appeared after a commit that changed three sentences of the prompt about something else (which disagreements to report). Temperature was 0 throughout. The check had been verified on this exact meeting, in two live runs, before that commit.

## Symptoms

- A fix verified on its motivating case stops working after an unrelated edit to the prompt.
- The wrong value is one the guard cannot object to: it is in the source.
- Repeat runs at a fixed prompt agree with each other, so a repeat-run check at one commit shows nothing. The variation is across prompt versions.

## Root Cause

The check validated the model's claim against the text without asking whether the text states that claim as the kind of thing it is. "215.10" is in the text. It is not written there as a dollar amount: it is the tail of a token the OCR mangled. A person reading "fpaa-215.10" does not see a figure. The check did.

The earlier digit-only version of the same check had the mirror fault and was caught in review: "$750.00" was found in "$75,000".

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** The check was verified by running the model, so the evidence for it was one model output per prompt version. Each later prompt edit silently discarded that evidence, and nothing reran the case.

## Rule Scope

- **Applies when:** code accepts or rejects a model-extracted value by looking for it in source text, and the source can be damaged or ambiguous (OCR, captions, scraped HTML).
- **Inverts or does not apply when:** the source is clean structured data, where presence is unambiguous. Also does not apply to a check on a value code computes itself; see the tier-drift entry.
- **Sibling docs:** `llm-list-extraction-single-draw-mistaken-for-baseline-2026-10-07.md` (a stored list is one draw), `llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md` (compute derivable fields in code), `guessed-natural-key-on-unreadable-input-2026-10-06.md` (a key guessed from unreadable input).

## Solution

**Anchor the check to how the source writes the thing, not only to whether the characters occur.** A figure now counts as found in documents only where the text writes it with a dollar sign directly before it:

```typescript
figureIsIn(decision.originalAmount, documentsText, { asDollarAmount: true })
```

"fpaa-215.10" fails that. The scan's "$277,571.80" and "$258.400.00" pass. Before choosing the anchor, measure what it costs: a read-only pass over production found all 45 stored figures that are found in their documents written there with a "$", so the stricter rule changed none of them. A transcript is searched without it, because captions often drop the sign.

**Compare values as what they are.** Dollars and cents are parsed separately, so a moved or missing separator cannot change the magnitude.

**When the two error directions cost differently, pick the rule that fails toward the cheap one.** A figure wrongly treated as unread falls back to the video or to "not stated". A figure wrongly treated as read publishes a number the document does not state. Every looseness in the matcher was resolved toward "unread".

## Prevention

**Code-level:** `src/pipeline/services/SummarizationService.test.ts` holds the passage itself: the test "does not let the documents govern a fragment of a figure the scan destroyed" feeds "fpaa-215.10" with a documents answer of "$215.10" and requires the video's figure. The `figureIsIn` tables pin both directions of the comparison.

**Process-level:** a model-dependent check is re-verified after every prompt edit, not once. `src/pipeline/scripts/summarize-repeat.ts` runs the summarizer several times over one stored meeting, read-only, prints each run's decisions and disagreements, and exits 1 when the runs differ:

```
pnpm tsx src/pipeline/scripts/summarize-repeat.ts ellettsville-town-council 2025-05-27 5
```

After any change to the summarizer prompt, run it on 2025-05-27 (unread figure), 2026-02-02 (a scan that writes "$258.400.00") and 2025-11-24 (a control) before rebuilding stored summaries.

**Clustering note.** This is the third entry on model variance in a load-bearing field, after the tier-drift and single-draw entries. The single-draw entry said the missing mechanism was a committed repeat-run check and that it was not built. It is built here: `summarize-repeat.ts`. It needs live model calls, so it is a tool an operator runs, not a CI gate. On its first run it showed the 2025-05-27 tabled fee ordinance at $750 in one run of three and at no amount in the other two.

## Planning / Calibration Notes

- **What widened the work:** #179 was scoped as one rule. It took the rule, a rewrite of the comparison, a dollar-sign anchor, and three review rounds on a duplicate-entry filter that the rule made necessary (#181 holds what is left).
- **What tightened the work:** measuring the anchor's cost on production data before adopting it. That turned a judgement call into a count.
- **Future planning adjustment:** a slice that adds a check on model output should name, at shaping time, every distinct output the model could plausibly give for the damaged case, and say what the check does with each. Here there were two, and only one was considered.

## Defect Classification

**Origin phase:** Design error. The check's design assumed the model returns one answer for a given passage.
**Fix type:** Correction for the dollar-sign case. Still open: a figure the OCR misreads into another valid dollar amount with its sign intact passes the check. Storing Tesseract's per-word confidence would judge the scan itself.

## Related

- #179, PR #180; #181 (the duplicate filter)
- #167, PR #172
- `llm-list-extraction-single-draw-mistaken-for-baseline-2026-10-07.md`

## Shelf Life

Evergreen for the pattern. The dollar-sign anchor is specific to these scans: revisit it if a body's documents print amounts in tables without the sign.
