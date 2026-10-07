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

Review found the first wrong direction. When a video joins a meeting that already has a documents-only summary, `processYouTubeVideo` stores the transcript and then calls `regenerateWithRetry`. Until regeneration succeeds, the page said "built from the meeting video and the official documents" and linked the video. A failed regeneration leaves that state in place until a later run retries.

The fix made documents win: a summary with no stored kinds is credited to the documents when any are attached. The re-review found the mirror image. Sibling slice #135 merged while this PR was in review, and its `attachDocumentsAndRegenerate` attaches a PDF to a video-only meeting before regenerating. An older video-only summary would then read "built from the official documents" with no video link.

No rule over the attached rows is right in both directions, because the rows are the meeting's current sources and the question is about the summary's past ones.

## Symptoms

- A page asserts something about a stored artifact that is true of its inputs today and was not true when the artifact was written.
- The wrong statement appears only between two pipeline steps, or indefinitely after the second step fails. Tests that seed a settled database never see it.
- A fix for one direction passes review and mutation testing, and the opposite direction turns up from a different write path.

## Root Cause

The summary's provenance is a write-side fact: only the code that built the summary knows what it read. The read side reconstructed it from a proxy (which rows are attached now) that agrees with the fact only when the writes have settled. The pipeline's attach-then-regenerate order makes the unsettled window a normal state, and a failed model call makes it a long one.

The stored column existed (`summaries.source_kinds`). The gap was the `[]` default for rows written before it, plus a boundary map that turned that gap into a read-side derivation rule.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** the proxy and the fact diverge only inside a window that page tests and query tests do not construct, so every check on a settled fixture confirms the guess. The delay between "attach" and "regenerate" is where the feedback is missing.

## Rule Scope

- **Applies when:** a reader displays or branches on a property of a derived artifact (a summary, a report, a cache entry), the property depends on what the artifact was built from, and the inputs can change without the artifact being rebuilt in the same transaction.
- **Inverts or does not apply when:** the artifact and its inputs are replaced atomically, so no reader can see one without the other; or the reader is asking about the inputs themselves ("which documents does this meeting have?"), where the attached rows are the fact and not a proxy for it.
- **Extends a sibling's exemption:** `guessed-natural-key-on-unreadable-input-2026-10-06.md` allows a fallback for a descriptive field because it merges nothing. That holds for storage. A descriptive field that is published as a statement to readers is a different case: the guess merges nothing and still tells the public something false.
- **Sibling docs:** `guessed-natural-key-on-unreadable-input-2026-10-06.md` (a guess standing in for a key), `permanent-outcome-from-ambiguous-evidence-2026-10-06.md` (evidence that is true now and false later), `boundary-map-drift-between-slices-2026-04-10.md` (a sibling slice changing what a contract means), `tri-state-return-for-pipeline-outcomes-2026-04-13.md` (the union shape used for the page's four states).

## Solution

What this PR ships is a stopgap with one known wrong direction, stated here so nobody reads it as closed.

`summarySourceKinds` in `src/db/queries.ts` uses the stored kinds when there are any. For a summary that stored none, documents win when the meeting has any, and the transcript is credited only when it has none. The page never sees kinds: `summarySourcesOf` turns them into a four-state union (`none`, `documents`, `video`, `both`), and a video link exists only in the two states built from the video.

The wrong direction that remains: an older video-only summary whose meeting gains a PDF is credited to the documents until its regeneration succeeds.

The correction belongs to the writer. Both places that call `stampSummaryFingerprint` (`processYouTubeVideo` and `attachDocumentsAndRegenerate` in `src/pipeline/orchestrator.ts`) already hold the sources the existing summary was built from, because they compute its fingerprint from them. Stamping the kinds in the same update records the fact before the attach changes the rows. Once no summary has `[]` kinds beside a non-empty fingerprint, the read-side fallback has nothing left to guess. Tracked as #149, which blocks the #137 backfill.

## Prevention

**Code-level:** `src/db/queries.test.ts`, "derives the kinds from the attached rows when the summary stored none, never crediting a video that joined later", pins the documents-first rule and fails when the transcript is credited beside documents. Nothing pins the opposite direction, because the read side cannot get it right; a test for it belongs with the writer-side change. A test that seeds the unsettled state (source attached, summary not rebuilt) is the case to add for any reader of a derived artifact.

**Process-level:**

- At decomposition, a read-side slice that must show a fact about a derived artifact should consume a stored column. A Produces line that says "derived from the rows attached" for such a fact is a flag: ask what the rows look like between the pipeline's attach and its rebuild.
- When a column is added with a default for old rows, decide in the same slice who backfills it. Leaving the default to a reader's fallback moves a write-side question to code that cannot answer it.
- When reviewing a fix for a guess, look for the mirror-image write path before accepting it, including paths added by sibling slices since the branch was cut.

**Clustering:** the nearest entry is `guessed-natural-key-on-unreadable-input-2026-10-06.md`. It is not the same pattern. There the guess fills a key and records merge; here nothing is unreadable and nothing merges, and the guess is wrong only while a staged write is in flight. This entry narrows that entry's "descriptive only" exemption, noted in both.

## Planning / Calibration Notes

- **What widened the work:** the slice was four commits; review plus a TypeScript audit added eleven fix commits and a second review. The base branch moved during review (#135 merged), and that merge is what exposed the second wrong direction.
- **What tightened the work:** two independent reviewers raised the first direction separately, and mutation testing on each fix showed which tests held their property.
- **Future planning adjustment:** when two sibling slices touch the same derived artifact from the write side and the read side, sequence the write-side slice first or have the read-side slice state which unsettled states it has considered.

## Key Decision

**Decision:** keep a read-side fallback for summaries with no stored kinds, documents first, and do not change the pipeline in this PR.
**Rationale:** the pipeline change is outside slice #136's boundary and touches code #135 merged the same day. Documents-first is right for every summary in the common case (written from PDFs before video summaries existed).
**Alternatives considered:** crediting every attached row (wrong when a video joins); comparing the stored fingerprint with the current sources to detect "behind" (detects the window, still cannot say what the summary was built from).
**Revisable:** yes, as soon as the writer stamps kinds (#149).

## Related

- PR #147, slice #136, PRD #127
- #135 (`attachDocumentsAndRegenerate`), #133 (regenerate and replace), #130 (the `source_kinds` column)
- #149 (stamp the kinds at the writer; the open half of this lesson)
- #82 step 5 (a meeting with a summary is not "unreadable"), implemented in this PR

## Shelf Life

When the pipeline stamps `source_kinds` wherever it stamps a fingerprint, and no stored summary has `[]` kinds, delete the fallback in `summarySourceKinds`. The Solution section is then history; the Rule Scope and Prevention sections remain evergreen.
