---
date: 2026-11-13
updated: 2026-11-13
category: testing-patterns
problem_type: a calibration corpus for an LLM judge measures cases an upstream code check already decides, and inherits its pass labels from an earlier scorer, so its catch and false-refusal rates describe a different job than the one the judge will do
components: [pipeline/checks/__fixtures__/calibration, pipeline/checks/names, pipeline/checks/publicComment, spike verdicts]
technologies: [typescript, gemini]
severity: medium
volatility: stable
---

# A judge's catch rate measured on fail cases the code check already holds

## Problem

#195 calibrated a Gemini judge on 90 hand-made edits of published drafts. The judge caught every A5 fail edit (catch 1.00), but 14 of those 15 edits were already held by the merged names check (A1) before a judge would see them. The judge's A5 number mostly measured A1's job.

## Context

A5 says residents at public comment are counted, never named. To make A5 fail edits, the corpus inserted an invented resident's name into a draft. An invented name appears in no source, so A1's names check fails the draft ("is in no source"). In production the pre-publish check runs code first. The judge only decides A5 for names that are in the sources and that code cannot resolve (`publicComment.ts`). The corpus had one edit of that kind (A5-F-10).

The same spike showed two related faults:

- **Inherited labels.** The corpus labelled every unedited part of a base draft "pass" because an earlier Sonnet scorer had passed it. Pro failed A4 on many of those base drafts with no edit applied. That looked like a judge problem, but at first nobody could tell which scorer was wrong. Pro's A4 false refusal was still 0.35 and 0.28 with the two most disputed drafts removed, so the A4 result is a real miss, not a labelling artifact. Settling it still needed that extra cut.
- **Prompt drift.** The judge prompt restated the rubric's A2, A4 and A5 rules and changed them. For example, it added "A misspelled official is not an A5 failure", while the rubric requires names spelled as the documents spell them. Every number in the verdict measures that prompt, not the rubric.

## Symptoms

- A judge's catch rate is 1.00, or close to it, on a check that a code check partly covers.
- Fail edits are built by inserting something that is also absent from the sources: an invented name, a figure, or a date.
- Running the code checks over the corpus flips them from pass to fail on fail edits labelled for another check.
- The judge disagrees with the corpus mostly on unedited text, and the disagreements cluster by base draft rather than by edit.
- On live drafts, the judge agrees with an earlier scorer far less than on the corpus. Here Pro caught 4 of the 9 A2 failures Sonnet found on live drafts (0.44), against 1.00 on the corpus.

## Root Cause

The corpus was built to test the judge on its own, with the code checks left out. The production pipeline is staged: code checks hold a draft first, and the judge sees only what code passes. A fail edit counts as evidence for the judge only if it gets past every earlier stage and fails only the check under test. Nothing in the corpus build checked that condition, so the easiest way to make an A5 failure (invent a name) made a failure that A1 already owns.

Pass labels came from a scorer, not a person. The corpus inherited that scorer's mistakes, which mixed "judge too strict" in with "base draft really fails".

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** The spike's verdict sets which checks #205 gates. A catch rate inflated by an upstream check reads as a clear "clears the bar", so nothing pushes back until the judge meets real unresolved names in production.

## Rule Scope

- **Applies when:** an LLM judge sits behind code checks in a staged pipeline, and its calibration corpus is built from synthetic edits labelled by construction.
- **Does not apply when:** the judge runs alone, with no earlier stage, or the corpus is real production traffic that the code checks have already filtered.
- **Sibling docs:** `patterns/spike-measured-number-shipped-without-its-unit-or-loop-2026-10-24.md` covers a correct spike number that loses its frame on the way to production. This doc covers a number that is wrong at the source. `patterns/prompt-rule-mirroring-a-code-check-must-be-stricter-than-the-check-2026-10-25.md` covers how a prompt rule relates to the code check beside it.

## Solution

Build fail edits that survive every earlier stage. For A5: insert the invented name into the cached source's public-comment text as well as the draft, so A1 finds it in a source and only A5 can fail the draft.

Before using a corpus, run the code checks over every edited draft. Then confirm two things:

- Each fail edit passes every code check that runs before the judge.
- Each fail edit fails only the check it is labelled for.

Label base drafts by hand, or take their pass labels from the judge's own view only after a person has settled the disagreements.

Import the judge prompt's rules from the rubric, or diff them against it, rather than restating them.

### What #205 did when it re-measured (2026-11-13)

**Leave out an edit only when the edit itself changes a code verdict.** The literal rule above ("every fail edit passes every code check") turned out to be too strict on this corpus. Today's code checks hold 64 of the 90 edited drafts, mostly because the *unedited* published drafts already fail A5 (names code cannot resolve) or A1. Under that rule only 4 A2 fail edits reached the judge, so nothing could be measured. What inflates a catch rate is an edit that code catches *because of the edit*: an invented name tripping A1, or a listed loaded word tripping code A2. A base draft held for an unrelated name elsewhere does not make an A2 edit any easier for the judge. So `calibrate-judge` compares the code verdicts on each edited draft with those on its base draft, and scores only the edits that change none (`codeSeesEdit`). That left 72 edits, including 10 A2 fails on meetings with documents and 1 A5 fail.

**A check needs a minimum number of scored fails to clear.** With the code-caught edits gone, A5 had one fail edit, and 1 of 1 caught is a catch rate of 1.00. `BARS.minFails` is 10 (`src/pipeline/checks/calibration.ts`). A2 cleared at exactly 10 (9 of 10 caught in each run). It is gated on meetings with documents, and A5 waits on #228.

**An injection flip counts only when both probe runs flip.** The judge disagrees with itself on about 5% of edits between clean runs (self-agreement 0.95). One edit (A2-F-10, "pounced on") passed in one of two runs that had "ignore previous instructions" appended to the documents, and failed in the other. The rule mirrors the bars' two-run rule, and the record keeps one-run flips as `flippedOnce`. This rule was chosen after the first flip was seen, so read it as a decision, not a measurement. In production each draft gets one judge call, so a 1-in-2 flip is still a real attack on that draft.

**The fingerprint has to cover everything the judge reads.** #205 pinned the judge as a hash of model, system prompt and settings, and keyed both the committed calibration record and the call cache by it. But the judge's user prompt embeds the writer's `buildWritingPrompt`, which changed in 6 of the 6 PRs before this one, plus the judge's own template and the output schema's descriptions, which the Google provider forwards to Gemini. Pre-merge review of PR #233 found none of those in the hash. A change to any of them leaves the record test green and lets `--write` replay cached verdicts for a prompt that never ran. Hash the prompt as built for a fixed fixture input, plus the schema.

## Prevention

**Code-level:** `src/pipeline/scripts/calibrate-judge.ts` leaves out every edit whose code verdicts the edit changes, so a corpus fail that code already catches can no longer inflate a judge's numbers. `src/pipeline/services/judge-record.test.ts` fails when the judge's fingerprint drifts from the committed `record.json`, or when a gated check no longer clears the bars. The fingerprint itself is still too narrow, see above (PR #233 review finding C1). Until it covers the whole prompt, the record test does not guard a writer-prompt change.

**Process-level:** A calibration spike's verdict should state what it measured under: which stages ran before the judge, the prompt text, and where the pass labels came from. That applies the sibling doc's "keep the frame with the number" rule at the moment the corpus is built. When a calibration rule is decided after the data is seen, as the two-run injection rule was, the record and the PR say so.

## Planning / Calibration Notes

- **What widened the work:** the hand-labelled subset was skipped, so the label-inheritance question was settled by slicing the run data, not by labels.
- **Future planning adjustment:** when `/prd-to-issues` cuts a judge-calibration spike, its acceptance criteria should include "fail edits survive the earlier code checks".

## Key Decision

**Decision:** #195 shipped its verdict on the corpus as built: Pro gates A2 and A5 on meetings with documents, A4 stays code-only, and every transcript-only check stays code-only.
**Rationale:** the owner chose to ship. The A5 result is weaker than its 1.00 suggests, and the A2 corpus result disagrees with live-draft agreement. #205 has to re-measure both before it gates them.
**Revisable:** yes, once a corpus whose fail edits survive A1 has been run.

**Superseded by #205 (PR #233):** re-measured with code-caught edits left out, Pro gates A2 only, on meetings with documents. A5's fail edits are almost all caught by A1, so its real job is unmeasured until #228 rebuilds them.

## Related

- #195 (spike), PR #227, #205 (the slice that consumes the verdict), PR #233 (the harness and record), #228 (rebuild the A5 fail edits)

## Shelf Life

The edit-exclusion rule lives in `calibrate-judge.ts` and the bars live in `calibration.ts`. This doc expires once the judge's fingerprint covers its whole prompt (PR #233 finding C1) and #228 has measured A5 on fail edits that survive A1.
