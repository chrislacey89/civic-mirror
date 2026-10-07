---
date: 2026-10-07
category: patterns
problem_type: read-side inference of a write-side fact across a staged write
components: [queries, meeting-page, pipeline, orchestrator, regenerate, summaries]
technologies: [typescript, drizzle, effect, vitest]
severity: medium
volatility: stable
---

# A fact guessed at read time from attached rows is wrong while a staged write is in flight

## Problem

The meeting page tells a resident what a summary was built from: the official documents, the meeting video, or both. For a summary that never recorded this, the query guessed it from the rows attached to the meeting. The pipeline attaches a new source first and regenerates the summary second, so between those two steps the attached rows describe a summary that does not exist yet. The page then states, as fact, sources the summary was not built from.

## Context

Slice #136 of PRD #127 added the sources line. Summaries written before #130 store `sourceKinds = []`, and the slice's boundary map said to derive the kinds for those "from the rows attached to the meeting". The first implementation credited every attached row.

Review found the first wrong direction. When a video joins a meeting that already has a documents-only summary, `matchVideoToMeeting` stores the transcript and then calls `regenerateWithRetry`. Until regeneration succeeds, the page said "built from the meeting video and the official documents" and linked the video. A failed regeneration leaves that state in place until a later run retries.

The fix made documents win: a summary with no stored kinds is credited to the documents when any are attached. The re-review found the mirror image. Sibling slice #135 merged while this PR was in review, and its `attachDocumentsAndRegenerate` attaches a PDF to a video-only meeting before regenerating. An older video-only summary would then read "built from the official documents" with no video link.

No rule over the attached rows is right in both directions, because the rows are the meeting's current sources and the question is about the summary's past ones.

#149 then moved the fact to the writer (PR #154): the pipeline stamps a summary's kinds in the same update as its fingerprint, just before it attaches a new source. Review of that PR found the same guess one step earlier. Two of the three stamping callers derived the kinds from every source the meeting held at that moment. The operator one-shot `drama:detect` attaches a transcript to an existing meeting without stamping, so a later PDF would have stamped an older documents-only summary as built from both.

## Symptoms

- A page asserts something about a stored artifact that is true of its inputs today and was not true when the artifact was written.
- The wrong statement appears only between two pipeline steps, or indefinitely after the second step fails. Tests that seed a settled database never see it.
- A fix for one direction passes review and mutation testing, and the opposite direction turns up from a different write path.
- The fix moves the derivation to the writer, and the writer still reads the attached rows. Its tests seed meetings with one kind of source, so they pass.

## Root Cause

The summary's provenance is a write-side fact: only the code that built the summary knows what it read. The read side reconstructed it from a proxy (which rows are attached now) that agrees with the fact only when the writes have settled. The pipeline's attach-then-regenerate order makes the unsettled window a normal state, and a failed model call makes it a long one.

The stored column existed (`summaries.source_kinds`). The gap was the `[]` default for rows written before it, plus a boundary map that turned that gap into a read-side derivation rule.

Moving the derivation to the writer does not by itself change what it reads. A stamp computed from the rows held just before an attach is right only if every earlier attach also stamped. That is a claim about every write path in the codebase, including operator tools, and one unstamped path makes the stamp record the guess permanently where the reader's guess was at least recomputed on each read.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** the proxy and the fact diverge only inside a window that page tests and query tests do not construct, so every check on a settled fixture confirms the guess. The delay between "attach" and "regenerate" is where the feedback is missing. The writer-side version has the same blind spot: fixtures that hold one kind of source cannot tell "the kinds of the held rows" from "the kinds the summary was built from".

## Rule Scope

- **Applies when:** a reader displays or branches on a property of a derived artifact (a summary, a report, a cache entry), the property depends on what the artifact was built from, and the inputs can change without the artifact being rebuilt in the same transaction.
- **Applies to a writer too when:** the writer records the property late (at the next attach, or in a backfill) and derives it from the inputs attached at that moment. Prefer an invariant of how the artifact was built over a census of its current inputs. Here the invariant is that a summary with no fingerprint was written by a single-kind path, so it was never built from both.
- **Inverts or does not apply when:** the artifact and its inputs are replaced atomically, so no reader can see one without the other; or the reader is asking about the inputs themselves ("which documents does this meeting have?"), where the attached rows are the fact and not a proxy for it.
- **Narrows a sibling's exemption:** `guessed-natural-key-on-unreadable-input-2026-10-06.md` allows a fallback for a descriptive field because it merges nothing. That holds for storage. A descriptive property of a derived artifact, published to readers and guessed from inputs that can change without a rebuild, is a different case: the guess merges nothing and still tells the public something false. A plain default such as a missing meeting type reading `"regular"` stays exempt.
- **Sibling docs:** `guessed-natural-key-on-unreadable-input-2026-10-06.md` (a guess standing in for a key), `permanent-outcome-from-ambiguous-evidence-2026-10-06.md` (evidence that is true now and false later), `boundary-map-drift-between-slices-2026-04-10.md` (a sibling slice changing what a contract means), `tri-state-return-for-pipeline-outcomes-2026-04-13.md` (the union shape used for the page's four states).

## Solution

Record the fact at the writer, and derive it from how the summary was built, not from what the meeting holds.

`stampSummaryFingerprint` in `src/pipeline/services/StorageService.ts` writes `source_kinds` in the same update as the fingerprint. Its three callers in `src/pipeline/orchestrator.ts` (`matchVideoToMeeting`, `attachDocumentsAndRegenerate` and `matchDocumentsToMeeting`) run it before they attach a source, so the kinds are stored before the rows change (#149, PR #154).

What the stamp should write: a summary with no fingerprint was stored by a path that read one kind of source, so the stamp names one kind. It is the documents when the meeting holds any with text, and the transcript otherwise. `matchDocumentsToMeeting` stamps a literal `["transcript"]`. The other two callers use `kindsOfUnfingerprintedSummary` in `src/pipeline/sources.ts`. `kindsOfSources`, which names every kind held, is for a summary that was just rebuilt from everything the meeting holds (`regenerateMeetingSummary`).

The read-side fallback in `summarySourceKinds` (`src/db/queries.ts`) stays for summaries that have never had a source attached since they were built: documents win when the meeting has any, and the transcript is credited only when it has none. Twenty-five production summaries depended on it on 2026-10-07. None held both a transcript and a document, and none was in the unsettled state.

`drama:detect` (`runDramaDetectForVideo`) still attaches a transcript to an existing meeting without stamping. The fallback answers "documents" there, which is right, and the single-kind stamp is right when a PDF follows. It is the reason "the pipeline stamps before every attach" is not a safe premise for later work.

## Prevention

**Code-level:** `src/db/queries.test.ts`, "derives the kinds from the attached rows when the summary stored none, never crediting a video that joined later", pins the documents-first rule and fails when the transcript is credited beside documents. Four tests in `src/pipeline/orchestrator.test.ts` (their names contain "stored without kinds") seed an unsettled state against a real database and assert the meeting detail query's `summarySources`. Each stamping caller has at least one. A test that seeds the unsettled state (source attached, summary not rebuilt) is the case to add for any reader of a derived artifact.

When a writer records such a fact late, seed a fixture where the attached rows and the fact disagree: here, a documents-only summary on a meeting that also holds a transcript. Single-kind fixtures pass for both the right rule and the wrong one.

**Process-level:**

- At decomposition, a read-side slice that must show a fact about a derived artifact should consume a stored column. A Produces line that says "derived from the rows attached" for such a fact is a flag: ask what the rows look like between the pipeline's attach and its rebuild.
- When a column is added with a default for old rows, decide in the same slice who backfills it. Leaving the default to a reader's fallback moves a write-side question to code that cannot answer it.
- When reviewing a fix for a guess, look for the mirror-image write path before accepting it, including paths added by sibling slices since the branch was cut.
- When a fix says "the callers already hold the sources the artifact was built from", list every path that can add a source, operator one-shots included, and check each one against that sentence. This entry made that claim in its first version and it was false for `drama:detect`.

**Mechanism for the recurrence:** the pattern recurred inside its own fix, so prose is not enough. The mechanism is the test in `src/pipeline/orchestrator.test.ts` named "reads a documents-only summary stored without kinds as built from the documents when a transcript attached by a one-shot sits beside them and regeneration fails". It fails if `attachDocumentsAndRegenerate` stamps every kind held. The `matchVideoToMeeting` stamp has no such test: it runs only for a meeting with no transcript, where the two rules agree.

**Clustering:** the nearest entry is `guessed-natural-key-on-unreadable-input-2026-10-06.md`. It is not the same pattern. There the guess fills a key and records merge; here nothing is unreadable and nothing merges, and the guess is wrong only while a staged write is in flight. This entry narrows that entry's "descriptive only" exemption, noted in both.

## Planning / Calibration Notes

- **What widened the work:** the slice was four commits; review plus a TypeScript audit added eleven fix commits and a second review. The base branch moved during review (#135 merged), and that merge is what exposed the second wrong direction. The writer-side follow-up (#149) was two commits, and independent review found the third direction in it.
- **What tightened the work:** two independent reviewers raised the first direction separately, and mutation testing on each fix showed which tests held their property.
- **Future planning adjustment:** when two sibling slices touch the same derived artifact from the write side and the read side, sequence the write-side slice first or have the read-side slice state which unsettled states it has considered.

## Key Decision

**Decision:** keep a read-side fallback for summaries with no stored kinds, documents first, and do not change the pipeline in this PR.
**Rationale:** the pipeline change is outside slice #136's boundary and touches code #135 merged the same day. Documents-first is right for every summary in the common case (written from PDFs before video summaries existed).
**Alternatives considered:** crediting every attached row (wrong when a video joins); comparing the stored fingerprint with the current sources to detect "behind" (detects the window, still cannot say what the summary was built from).
**Revisable:** yes, as soon as the writer stamps kinds (#149).

**Decision (#149, 2026-10-07):** keep the read-side fallback after the writer stamps kinds.
**Rationale:** summaries that have had no source attached since they were built still store `[]`, and the fallback is correct for them.
**Revisable:** yes, after a one-time backfill of kinds on those rows.

## Related

- PR #147, slice #136, PRD #127
- #135 (`attachDocumentsAndRegenerate`), #133 (regenerate and replace), #130 (the `source_kinds` column)
- #149 and PR #154 (stamp the kinds at the writer)
- #82 step 5 (a meeting with a summary is not "unreadable"), implemented in this PR

## Shelf Life

When no stored summary has `[]` kinds (after a one-time backfill of the older rows) and every path that attaches a source stamps first, delete the fallback in `summarySourceKinds`. The Solution section is then history; the Rule Scope and Prevention sections remain evergreen.
