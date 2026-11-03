---
date: 2026-11-02
category: testing-patterns
problem_type: a rule that clears a name from a privacy gate is pinned only by must-pass fixtures and a one-directional audit, so it silently admits false passes
components: [pipeline, pre-publish-check, public-comment-check, names-check]
technologies: [vitest, typescript]
severity: high
volatility: stable
---

# A rule that clears a name from the public-comment gate needs a must-fail fixture for every word class it clears

## Problem

The A5 check (#199) holds a summary that names a resident who spoke at public comment. Every rule that lets a name through, because the minutes write a title, an office or an organisation beside it, is a classifier with two error directions. The audit over the 36 stored summaries can see only one of them: a false hold shows up as a failing meeting, while a false pass publishes a neighbour's name and shows up nowhere. Five false passes shipped behind green tests and a 0-false-hold audit before independent reviewers found them.

## Context

The slice cleared a name inside the public-comment section when the section wrote "a role or office beside it", the exception the #194 spike asked for after a county official presenting at public comment was held. The first implementation took any title word within three words of the name, or any title in the clause after it, or an organisation. The audit on the 36 reported 3 marked-section failures, all genuine, so the acceptance bar ("≤ 1 false hold, hand-reviewed") was met on the first run.

Two independent review sub-agents and five breaker passes then found, by probing with invented residents, that each of these cleared a resident:

| Rule as first shipped | False pass it opened | Found by |
|---|---|---|
| a title within three words before the name | "Chairman Smith recognized Ada Lovelace, 12 Elm Street" (the chair's title clears the speaker) | review probe |
| any title word in the clause after the name | "Ada Lovelace, president of the Oak Hills HOA" | review probe |
| an organisation word beside the name | "Ada Lovelace of Elm Builders LLC" disputing a fine (a business owner is a resident by the rubric) | author's own re-read |
| an office list that kept generic job titles | "Ada Lovelace, manager of Elm Bar"; "Chief Ada Lovelace" | delta review probe |
| a title directly after fire/school/parks/library | "Ada Lovelace, a school teacher"; "library assistant" (#224) | breaker probe |

A separate artifact sat under the first run: #198's name extractor read "He explained" as a surname before an attribution verb, so every draft with such a sentence held on A5 and the blank for it landed inside "Headdy" as "[name]addy". The audit showed that one, because it was a hold.

## Symptoms

- The audit's false-hold count is zero or one, and no test anywhere expects a `fail` from a sentence that carries the clearing word beside a private group.
- A reviewer's probe with an invented resident and a plausible minutes sentence ("the Mayor thanked …", "president of the HOA") passes the gate.
- A breaker that widens the clearing rule (the window, the word list, the bridge) leaves the suite green.
- A pronoun or a street appears in the audit as a held meeting, with a fragment of a real word beside the blank.

## Root Cause

A clearing rule is an exclusion from a privacy gate, and the two errors are not equal: a false hold costs a regeneration, a false pass puts a resident's name on a public page. The acceptance bar measured only the cheap direction, and each fix to a false hold widened the rule with nothing pinning where it stops. The word lists were the boundary (which titles count as an office), and the fixtures named four example words rather than the boundary, so a word added to the office list cleared residents with every test green.

## Learning Level

- **Level:** Pattern. This is the second recording of the pattern in `grounding-check-exclusion-trades-false-holds-for-false-passes-2026-10-21.md`, on the names side of the same gate.
- **Feedback loop or delay:** the audit rewards the change that hides the cost. Each widening of a clearing rule lowers the one number the audit reports and raises a number nothing reports.

## Rule Scope

- **Applies when:** a gate decides per name (or per token) whether to skip checking it, the skip is driven by a word list or a window, and a skipped item cannot fail. The A5 title, office and organisation rules, `writtenAsPlace`, and #198's `OPENERS`/`TITLES`/`NOT_A_PERSON` lists are all of this shape.
- **Inverts or does not apply when:** the rule routes the item to another check rather than skipping it (a name on the officials list is grounded, not skipped: the list is reviewed by hand and the name still goes through A1). Also does not apply to rules that widen what *holds*, whose cost is a regeneration and whose audit the stored corpus does measure.
- **Sibling docs:** `grounding-check-exclusion-trades-false-holds-for-false-passes-2026-10-21.md` (the figures side of the same gate; the fixture discipline and "show each fixture red"), `../patterns/check-on-model-output-passes-or-fails-by-which-output-the-model-gave-2026-10-08.md` (fail toward the cheap direction).

## Solution

**Pin the boundary, not the examples.** A table test iterates every title the extractor knows and, for each, asserts whether a resident written as "Ada Lovelace, [that title] of the Oak Hills HOA, spoke" inside the public-comment section is held or cleared, against a list in the test of the titles that may clear. A title added to the office list in code goes red until it is added to that list on purpose. That is the mechanism this entry ships (see Prevention).

**Clear by office, not by title.** Inside the section only a title that names a government office on its own clears a name (mayor, commissioner, sheriff, trustee, …), or any title beside a government body named with county, town, township, department, district and the like, or "representing". An organisation alone does not clear, because a business owner at public comment is a resident. The same organisation rule still resolves a vendor in the documents of a meeting with no marked section, where the question is a different one.

**Take the title from the name's own run.** A title clears a name only from the capitalised run immediately before it ("County Commissioner Ada Lovelace"), bridging "of" or "for" between capitalised words ("Chief of Police Ada Lovelace"). A lowercase verb between the title and the name ends the run, so the chair's title does not clear the speaker the chair recognises.

**Probe with invented residents in the shapes minutes actually use.** "The Mayor thanked …", "Chairman recognized …", "president of the HOA", "a school teacher", "of 792 Lantern Lane", "Mr. Lovelace". Each probe that passes is a must-fail fixture to add. Two reviewers and five breakers each found at least one; the author found none by reading.

## Prevention

**Code-level:** `src/pipeline/checks/publicComment.test.ts`, "every title the extractor knows, beside a private group in the section": the table over `TITLES` against `OFFICES_THAT_CLEAR_BESIDE_A_PRIVATE_GROUP`. Beside it, the must-fail fixtures for each rule: the chair-recognises and Mayor-thanked lines, the HOA president and member lines, the manager-of-Elm-Bar and Chief lines, the honorific-surname line, and "A letter from Denise Lane". #225 records the two guards (the of/for bridge and the sentence-boundary mirror) that still lack a fixture that goes red when loosened.

**Process-level:** a slice whose acceptance bar is "≤ N false holds on the archive" needs its partner bar in the same criterion: every clearing rule has a must-fail fixture, and a mutation of each is killed. The `/execute` step's audit cannot stand in for that. When `/prd-to-issues` writes a `[QA-RELI]` criterion for a gate that skips items, it should name both directions; this is a pipeline-level gap, so consider `/improve-pipeline` for the criterion template.

**Clustering note:** this is the second recording of the 2026-10-21 pattern, in the same category. That entry shipped fixtures and said a mechanism beyond them would need each pattern named in the test, which is the fixture discipline itself. On the names side the boundary is a word list, which a test can enumerate, so the table test above is the mechanism the first entry could not build. It pins the office boundary; it does not pin the window, the bridge or the organisation rule, which still rest on the per-rule fixtures.

## Planning / Calibration Notes

- **What widened the work:** two `/fix-findings` rounds and two `/pre-merge` re-runs after a green first review, each opening a narrower class of the same false pass. The thread's one-line exception ("a role or office beside it") took three definitions of "office" to land.
- **What tightened the work:** the read-only `summaries:audit` run during `/execute` found the pronoun artifact and the street-as-person hold on the first pass, before review. Breakers that probe with invented sentences found every false pass; the suite found none.
- **Future planning adjustment:** the assumption "16 of 36 meetings mark public comment" was 15 of 35 by heading line, with 3 of those agendas; the officials list covers only the town council, so every name on the other three bodies holds until the judge. Write the hold count the judge inherits into the slice's acceptance criteria, not only the false-hold count.

## Actuals Worth Reusing

- **Comparable future work:** #200 (A2 loaded words, A3 artifacts) and the judge's A5 calibration (#205), both of which clear or hold on word lists.
- **Reusable baseline:** one review round per definition of the clearing word class; budget two fix rounds for a word-list gate and stop there (the third round found a new contradiction more often than it closed one, per the pipeline's own record).

## Key Decision

**Decision:** inside the public-comment section, an organisation beside a name does not clear it; a title clears it only as a government office or beside a government body.
**Rationale:** the rubric reads a business owner disputing their own matter at public comment as a resident, and the one false alarm the exception was written for was an official of another body.
**Alternatives considered:** the thread's literal reading, "a role or office beside it", with any title word (shipped first, opened the HOA president and manager cases); a narrower list of office words only (shipped second, kept generic job titles).
**Revisable:** yes, when the judge in #205 takes over A5 for unresolved names, at which point code may hold on every non-official and let the judge clear.

## Related

- #199, PR #223, #224, #225, #198, #194, PRD #193
- `docs/solutions/testing-patterns/grounding-check-exclusion-trades-false-holds-for-false-passes-2026-10-21.md`

## Shelf Life

Until A5 is decided by the calibrated judge (#205) for every name code cannot resolve, and code holds rather than clears on any title. The table test stays useful as long as a word list clears anything.
