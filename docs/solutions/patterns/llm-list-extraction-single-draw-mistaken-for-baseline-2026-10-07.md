---
date: 2026-10-07
category: patterns
problem_type: one draw of an unstable LLM list extraction treated as the baseline a later draw regressed from
components: [pipeline, summarization, ai-boundary, regeneration]
technologies: [gemini, ai-sdk, effect]
severity: high
volatility: stable
---

# A stored LLM list is one draw; a later draw that differs is not evidence the new input caused it

## Problem

When a stored LLM extraction is rebuilt after something changes (a new source, a new prompt, a new model) and the rebuilt list has lost entries, the change looks like the cause. It may not be. If the extraction gives a different list on each run over the *same* input, the stored list was one draw and the rebuilt one is another, and the change that prompted the rebuild is a bystander.

## Context

Each meeting stores a list of fiscal decisions extracted by Gemini. The #137 backfill attached video transcripts to 24 Town Council meetings and rebuilt each summary from the PDFs plus the transcript. Several rebuilt lists had lost decisions the PDF-only list held, or changed an amount (#167). The issue asked whether the longer combined input was crowding out the PDF's decisions, or whether the combined-source prompt rules were at fault.

Neither. The two cases the issue named were small inputs (8k and 19k characters of minutes), and in both the rebuilt *prose* still described the missing decision. Running the unchanged prompt repeatedly settled it:

| Meeting | Decision | Documents alone | Documents + transcript |
|---|---|---|---|
| 2026-06-08 | $8,000 legal invoice | 1 of 6 runs | 1 of 6 runs |
| 2025-11-24 | Resolution 38-2025, $43,900 | 1 of 5 runs | 3 of 5 runs |

The PDF-only list being mourned was a lucky draw. On 2025-11-24 the transcript made the decision *more* likely to appear.

## Symptoms

- A rebuilt list is missing entries the previous list had, and the prose from the same call still describes them.
- The losses cluster in borderline classes: tabled motions, motions with no dollar amount, accounts payable votes, an invoice questioned during one.
- One item is one entry in some lists and three in others.
- Across a batch the treatment is inconsistent in both directions: a class dropped in some meetings and added in others. A real input effect would lean one way.

## Root Cause

Two conditions together.

**The membership rule was underspecified.** The prompt said to extract decisions "formally moved, seconded, or voted on". It did not say whether a tabled motion counts, whether a motion with no stated amount counts, how to treat a vote to pay claims, or whether a resolution carrying three amounts is one entry or three. Each run settled those for itself. This is different from the drift in the sibling doc below: there the unstable field was a pure function of other fields and code could own it. List membership is a judgment, so code cannot compute it; the instructions have to settle it.

**Regeneration replaced the whole list with a fresh draw.** Nothing compared the new list with the old, and nothing in the service made the documents' decisions survive a rebuild, though the prompt said documents govern.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** A stored extraction is read far more often than it is produced, so a list is seen once and taken as what the model says about that input. Variance only shows when something forces a second draw, and the thing that forced it takes the blame.

## Rule Scope

- **Applies when:** an LLM output is stored, later rebuilt, and the two versions are compared to judge the change that prompted the rebuild; and the output is a list whose membership is a judgment call.
- **Inverts or does not apply when:** the unstable field is derivable from other fields in the same response. Compute it in code instead; see the sibling doc. Also does not apply when repeat runs over the old input agree with each other: then the difference really does come from the change, and the input or the prompt is the place to look.
- **Sibling docs:** `llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md` (drift on a mechanically derivable field; also records that temperature 0 does not remove variance).

## Solution

**Diagnose with repeat runs before reading a diff.** Run the old configuration over the old input five or six times, and the new configuration the same number. Count how often each disputed entry appears in each. This took a 40-line throwaway script and a few cents, and it reversed the hypothesis in the issue.

**Settle the membership rule in the instructions.** The prompt now says a tabled or denied motion is an entry, a motion with no stated amount is an entry with amount 0, one motion is one entry, an accounts payable vote is one entry plus one for an invoice singled out during it, and amounts are never estimated or annualized. With that and temperature 0, every disputed entry came back in each repeat run: four over the 2025-11-24 minutes alone on a first draft of the rules, then two per meeting through the shipped service on seven affected meetings.

**Give the governing source its own call, and merge in code.** With documents and a transcript, the service extracts from the documents alone and keeps those decisions as extracted, then asks the every-source call only for decisions the transcript adds:

```typescript
const documentDecisions = bothKinds
	? (await config.generateFn({ sources: documentsOnly, meetingContext })).fiscalDecisions
	: [];
const raw = await config.generateFn(
	bothKinds ? { ...input, recordedDecisions: documentDecisions } : input,
);
const fiscalDecisions = [...documentDecisions, ...raw.fiscalDecisions];
```

"Documents govern" is now a property of the code, which a unit test can hold, and no longer a sentence in a prompt.

## Prevention

**Code-level:** `src/pipeline/services/SummarizationService.test.ts`, the "documents and a transcript together" tests, hold that a decision from the documents call is in the result when the every-source call omits it. Removing the documents decisions from the merge fails two of them.

**Process-level:** before a bug about a rebuilt LLM output is given a cause, run the pre-change configuration several times over the pre-change input. If those runs disagree with each other, the bug is instability and the reported diff is a sample of it.

**Clustering note.** This is the second entry on run-to-run variance in a load-bearing LLM field; the first is the tier-drift doc. The mechanism shipped here is the merge test above, which covers the half code can own. For the other half, an unstable membership rule, the closest mechanism is a committed repeat-run check that diffs lists across runs. It was not built: it needs live Gemini calls, so it cannot run in CI, and the probe used for #167 was a throwaway. The review of PR #172 raised a `--dry-run` for `summaries:regenerate` that prints old and new lists, which would be its natural home.

## Planning / Calibration Notes

- **What widened the work:** the issue's two hypotheses were both wrong, so the fix moved from the combined-source rules to the extraction rules every summary uses. A forced-regenerate command also had to be added, because `run` skips a meeting whose sources are unchanged.
- **What tightened the work:** the repeat-run probe. It also served as the acceptance check for the new prompt.
- **Future planning adjustment:** when a slice changes the input or prompt of a stored LLM extraction and then rebuilds stored rows, plan a repeat-run comparison on a handful of rows before the rebuild, and treat "compare the rebuilt output with the one it replaces" as part of the slice.

## Defect Classification

**Origin phase:** Specification error. The membership rule never said what to do with the borderline classes.
**Fix type:** Correction for the two root causes above. Still held only by the prompt: that the every-source call does not repeat a recorded decision (PR #172 review, finding 1).

## Related

- #167, PR #172
- #137 backfill results: https://github.com/chrislacey89/civic-mirror/issues/127#issuecomment-6048943229
- `llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md`

## Shelf Life

Evergreen for the diagnostic rule. The prompt wording is tuned on Town Council minutes with `gemini-2.5-flash`; recheck the repeat-run agreement when the model changes.
