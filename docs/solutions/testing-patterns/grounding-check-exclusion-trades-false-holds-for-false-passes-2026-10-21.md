---
date: 2026-10-21
category: testing-patterns
problem_type: an exclusion added to a grounding check to stop false holds is pinned only by must-pass fixtures, so it silently admits false passes
components: [pipeline, pre-publish-check, figures-check, summarization]
technologies: [vitest, typescript]
severity: high
volatility: stable
---

# A rule that tells a grounding check "this number is not a figure" trades a false hold for a false pass

## Problem

The A1 figures check (#197) holds a summary when a number in it is not in the meeting's sources. Every false alarm was fixed the same way: add a rule that says some number is not a figure ("5-6 buildings" is a range, "March 23" is a date, "Ordinance 26-10" is an identifier). Each rule removes the number from checking entirely. A rule that reaches too far does not cause a hold. It lets a made-up number publish, and nothing reports it.

## Context

The first audit over the 36 stored summaries held seven meetings on votes that agreed with the record. Each was fixed by an exclusion and given a fixture asserting that the sentence passes. Three review rounds followed. Each found that the previous round's exclusion had a false pass behind it:

| Exclusion added | False hold it fixed | False pass it opened |
|---|---|---|
| a dash pair is a tally only beside a vote word | "5-6 buildings" | widening the window to nine words left every test green |
| stop words (`for`, `at`, `from` …) end the vote-word window | "approved plans for 5-6 buildings" | "voted at 3-2" against a 4-1 roll call passed |
| "Month N" is a date | "March 23" against a record writing "3/23/2026" | "In May 40 residents spoke" passed with no 40 in the record |

All four were found by mutating the rule and seeing the suite stay green, or by probing the check with a sentence the fixture did not cover. None were found by the tests the fixing commit added.

## Symptoms

- An audit's false-alarm count drops after a fix, and no test anywhere expects a `fail` from the new rule.
- Loosening the new pattern (`{0,2}` to `{0,9}`, `\d{1,2}` with no 1–31 cap, `[a-z]+s\b` to `[a-z]+ees\b`) leaves the suite green.
- A fixture added "for" the fix passes on the commit before the fix. "January 19-25" already passed, because a different rule blanked it.

## Root Cause

An exclusion is a classifier: it puts each number into "check it" or "skip it". The audit's false alarms are evidence for one side of that boundary only. A must-pass fixture pins that the rule reaches *at least* that far. Nothing pins that it stops. And the gate's two error directions are not equal: a false hold costs a regeneration, while a false pass publishes a number the record never states.

A second, plainer cause sat under the first. The original fixtures for the vote-count fixes were inserted by a scripted string replace whose anchor no longer matched after the formatter rewrote the file. The insert did nothing, the suite stayed green, and the PR body said the fixes were "covered by fixtures". `/execute`'s "mutate at the point of consumption" step would have caught it, and it was skipped.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** the audit measures false holds only. Each fix lowers that number, which reads as progress, while the false-pass count it may raise is not measured anywhere. The loop rewards exactly the change that hides the cost.

## Rule Scope

- **Applies when:** a check grounds model output against source text and excludes some tokens from checking (dates, identifiers, ranges, garbled tokens, spelled numbers), and a skipped token cannot fail the check.
- **Inverts or does not apply when:** the rule does not skip anything but routes it elsewhere with its own check. Example: a stated tally is not a figure, but it is checked against the roll call. There a reach that is too wide produces a second verdict, not silence. Also does not apply to rules that widen what *grounds* a figure (spelled-out source numbers), whose risk runs the other way and is covered by `check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md`.
- **Sibling docs:** `check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md` (pick the rule that fails toward the cheap direction), `typescript-only-fixes-hiding-runtime-regressions-2026-05-01.md` (a green suite that never exercised the change).

## Solution

**Give every exclusion a fixture on both sides of its boundary.** A must-pass sentence from the false alarm, and a must-fail sentence that looks like the false alarm but carries a real figure. For "Month N is a date", that pair is "The hearing is set for March 23." (record writes 3/23/2026, must pass) and "In May 40 residents spoke." (no 40 in the record, must fail).

**Show each fixture red before trusting it.** Remove the rule, run the test, see it fail, restore. A fixture that passes with the rule removed is testing something else.

**Bound the exclusion by what the thing is, not by what the false alarm looked like.** A day is 1–31. A tally sits right after a vote word. Each bound is a fact about dates or votes, not about one sentence.

## Prevention

**Code-level:** `src/pipeline/checks/figures.test.ts` holds both sides for the date rule (the must-pass date cases, and the must-fail table "does not read %s after a month as a date") and for the garbled-token rule (the "fpaa-215.10" case in "fails A1 on %s").

**Process-level:** when an audit drives fixes to a gate, count the fixes that remove numbers from checking separately, and give each a must-fail fixture in the same commit. Run `/execute`'s point-of-consumption mutation on each new rule before claiming it is covered.

**Clustering note:** this is not a second recording of the 2026-10-08 entry. That entry is about which output the model gave for a damaged passage. This one is about the check's own exclusion rules, independent of the model. No mechanism beyond the fixtures above is shipped. A lint rule cannot tell a skip-rule from any other regex, and the closest workable guard, a test that every `NOT_COUNTS` pattern has a must-fail case, would need each pattern named in the test, which is the fixture discipline itself.

## Planning / Calibration Notes

- **What widened the work:** three review rounds after the feature was built, each opening a new class. The audit's ≤ 1 false-hold bar was met on the first pass, but met by a measure that cannot see false passes.
- **What tightened the work:** independent breakers that mutate the rule rather than rerun the suite. Every false pass in the table came from one.
- **Future planning adjustment:** a slice that adds a grounding gate should state its acceptance bar in both directions. "≤ 1 false hold on the archive" needs a partner, e.g. "every exclusion has a must-fail fixture, and a mutation of each is killed".

## Related

- #197, PR #210, PRD #193
- `docs/solutions/patterns/check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md`

## Shelf Life

Until the gate grounds figures by a parser that understands dates, ranges and identifiers as types rather than by exclusion patterns.
