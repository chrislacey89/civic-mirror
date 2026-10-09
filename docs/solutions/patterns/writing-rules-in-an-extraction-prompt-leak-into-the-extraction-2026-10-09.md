---
date: 2026-10-09
category: patterns
problem_type: prose instructions added to a structured-extraction prompt change what the extraction returns
components: [pipeline, summarization, ai-boundary, prompt]
technologies: [gemini, ai-sdk, effect]
severity: high
volatility: stable
---

# Writing rules in a shared extraction prompt leak into the extraction

## Problem

One Gemini call returns both the fiscal ledger (`fiscalDecisions`, governed by rules 1–20) and the text a resident reads (`highlights`, `prose`). Adding rules for the text changed the ledger three separate ways, none of them mentioned in the rules that were added.

## Context

PR #186 first added rules 21–34 to the summarizer's single `SYSTEM_INSTRUCTIONS` in `src/pipeline/services/GeminiSummarizer.ts` (since split into `LEDGER_INSTRUCTIONS` and `WRITING_INSTRUCTIONS`), encoding `docs/writing-rubric.md`: headline and lede, importance order, paragraphs, plain words, no residents named, figures as the record writes them. Every rule was about the prose. `summarize-repeat.ts` was run three times per meeting with the old prompt and the new, read-only against production, on the four meetings used to draft the rubric and later on the three meetings `check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md` says to run after any prompt change.

## Symptoms

Three leaks, each found only because the ledger was compared run for run:

| Writing rule as first written | Effect on the extraction | Meeting |
|---|---|---|
| Rule 21's example headline was a real headline from a test meeting ("Council accepts $139,775.03 bid to resurface five streets"; "A $200,000 town home pays $64–$66 more under either 2027 budget") | The model returned the example word for word as that meeting's headline, 3 of 3 runs. It could not be told from a headline it wrote. | 2026-10-05 |
| Rule 24 listed "senior hires and departures" among the items the prose should put first | Two firefighter hires and a handbook ordinance, none with a dollar amount, entered `fiscalDecisions` in 3 of 3 runs. Rule 2 excludes them; the old prompt gave none in 3 of 3. | 2026-08-10 |
| Rule 34 restated rule 2's exclusion in shorter words: "a motion that only hires or appoints a person, or changes a policy, with no dollar amount stated is not an entry" | A rates resolution (Resolution 03-2026, labor and equipment costs, no amount) dropped out of `fiscalDecisions` in 3 of 3 runs. The old prompt kept it in 3 of 3. | 2026-02-02 |

Two of the three were caught by the meetings chosen to test the writing. The third was caught only by the meeting the 2026-10-08 entry names as a required re-check, which the first pass skipped.

## Root Cause

The model reads the prompt as one document. A category named anywhere in it as mattering is a category it extracts; a category restated anywhere in it as excluded is excluded by the restatement's wording, not the original's. A worked example in the prompt is a candidate answer. The ledger rules were stable only while they were the only rules that named categories at all.

The restatement is the same failure `references/restated-claims.md` describes for prose contracts: rule 2 and rule 34 stated one claim at two operative sites, and the model acted on the shorter one.

## Learning Level

- **Level:** Pattern. Three instances on one branch, in one prompt, from one kind of edit.
- **Feedback loop or delay:** Nothing in the output marks a ledger entry as "caused by a writing rule". The ledger is read far more often than it is produced, and a changed list looks like the model's view of the meeting, not of the prompt. Only a run-for-run comparison against the old prompt shows it. The 2026-10-07 entry made that comparison the mechanism; this entry is the case where the comparison was run on the wrong meetings first.

## Rule Scope

- **Applies when:** one model call returns a structured extraction and free text from the same instructions, and an edit touches only the text rules. Also when any rule includes a worked example drawn from the data the prompt will see.
- **Inverts or does not apply when:** the extraction and the text come from separate calls with separate prompts, which is where this entry ended up. Then a text rule cannot reach the extraction, and the cost is a second call per meeting. The discipline edits in Solution are still worth keeping in the writing prompt; they are no longer what protects the ledger.
- **Sibling docs:** `llm-list-extraction-single-draw-mistaken-for-baseline-2026-10-07.md` (the comparison this entry relies on, and why three runs is thin); `check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md` (an unrelated prompt edit flipping a verified figure; names the re-check meetings); `llm-scoring-tier-drift-mechanical-guardrails-2026-05-01.md` (compute in code what code can compute).

## Solution

Three edits to the writing rules were tried first, each confirmed by three runs against the old prompt's three, and together they were not enough: the paraphrase in rule 34 that stopped the hires on 2026-08-10 was what dropped the rates resolution on 2026-02-02, and removing it brought the hires back. One prompt serving two outputs tipped one way or the other with every wording.

The fix is structural. `createGeminiSummarizer` makes two calls:

1. **The ledger call** uses `LEDGER_INSTRUCTIONS`, the summarizer's prompt from before any writing rule existed, byte for byte. It returns `fiscalDecisions`, `budgetDiscussions` and `sourceDisagreements` exactly as it always did, so the ledger cannot regress from a writing edit by construction.
2. **The writing call** uses `WRITING_INSTRUCTIONS`, a standalone prompt that encodes `docs/writing-rubric.md`, and receives the sources plus the ledger the first call produced (`buildWritingPrompt`). It returns `highlights` and `prose` only.

The service's documents-only pass, which reads nothing but the ledger, sets `ledgerOnly: true` and skips the second call. The cost is one extra Gemini Flash call per meeting summarized.

Two of the discipline edits stay as writing-prompt hygiene: examples are invented (a real one was returned verbatim), and no category the ledger excludes is named as mattering. The writing prompt does restate the ledger prompt's attribution rule (rule 13 there, rule 10 here), on purpose: the two prompts are separate calls, so a restatement can no longer reach the ledger, and a standalone prompt has to carry the rule itself.

One limit worth knowing: the writing call receives the model's raw ledger for the pass plus the documents' recorded decisions, not the service's final governed ledger (`SummarizationService` resolves unread figures and drops duplicates after the generator returns). In the unread-figure case the writer can see a transcript figure the service later discards. Moving the writing call into the service, after the merge, would close that; it is noted in #187.

## Prevention

**Code-level:** `src/pipeline/services/GeminiSummarizer.test.ts`, "the ledger prompt and the writing prompt": `LEDGER_INSTRUCTIONS` must equal `__fixtures__/ledger-instructions.txt`, the pre-branch prompt, byte for byte, so any edit to the ledger prompt is a deliberate fixture change; the writing prompt never asks for `fiscalDecisions`; and the writing prompt's dollar figures are not the four real figures that were once pasted in. `SummarizationService.test.ts` pins that the documents-only pass asks for the ledger only.

**Process-level:** `pnpm summarize:recheck` runs the three meetings the 2026-10-08 entry names, five times each. A prompt change is not done until it has been run and its ledgers compared with the old prompt's; the meetings chosen to test the new behaviour are not a substitute. A `/pre-merge` reviewer caught the omission here by reading that entry; the script exists so the next author does not depend on the reviewer.

## Planning / Calibration Notes

- **What widened the work:** the prompt went through four correction rounds after the first draft, each one a repeat-run finding. Budget a prompt edit as "draft, then two or three measured corrections", not as a single commit.
- **What tightened the work:** `summarize-repeat --json` plus a compare page made each round a few minutes; the old-prompt baseline was a `git show e20a4b5:path > path` swap and three runs.
- **Future planning adjustment:** a slice that edits the summarizer prompt should name, at shaping time, which meetings will be re-run and which ledger entries are the sentinels, and should include the 2026-10-08 entry's three by default.

## Defect clustering

The nearest entries in this category are the two siblings above, both about run-to-run variance in a load-bearing field. This entry's pattern is different: not that one draw varies from another, but that an edit to one part of a prompt changes the answer to another part, deterministically (3 of 3 both ways). It is the fourth entry on model output in this category in six months. The structural fix (separate calls) was built here after three prompt-only rounds failed to hold both sentinels at once.

## Related

- PR #186
- `docs/writing-rubric.md`

## Shelf Life

Evergreen while any one model call is asked for both a structured extraction and free text. The separation in `createGeminiSummarizer` is the mechanism; this entry is why it must not be folded back into one call to save a request.
