---
date: 2026-10-06
category: patterns
problem_type: silent production degradation
components: [pipeline, orchestrator, transcription, held-videos, alerts]
technologies: [typescript, effect, youtube-transcript, vitest]
severity: high
volatility: stable
---

# A permanent outcome recorded from ambiguous or time-varying evidence drops real input silently

## Problem

A pipeline that gives an unusable row a permanent outcome ("held, never look again") is only as right as the evidence the outcome was recorded on. Two kinds of evidence look conclusive and are not: a third-party library's error class, whose name claims more than its code checks, and a fact about the source that is true today and false next week. Either one turns a retryable condition into a row that is skipped forever, with `errors=0` and no alert after the first.

## Context

Issue #131 added `held_videos`: a playlist video the pipeline cannot use is recorded once, alerted once, and skipped by every later run. That is the permanent outcome `guessed-natural-key-on-unreadable-input-2026-10-06.md` asks for when a source is re-read in full. One hold reason is `no-captions`, for a video with captions turned off.

Two things made "captions are off" harder to know than it looked.

1. `youtube-transcript` 1.3.1 throws `YoutubeTranscriptDisabledError` for any watch page that carries no caption tracks. That includes an unavailable video (confirmed live with a nonexistent ID) and, per open upstream reports, a page served to a blocked cloud host. The error's name states a cause; the code that throws it checks only an absence.
2. Even a correct "this playable video has no caption tracks" reading changes with time. YouTube generates automatic captions some time after upload, and the PRD expects videos within days of the meeting. The first review of the PR caught this; the implementation had not.

## Symptoms

- A video is missing from the site and is in `held_videos` with a reason that is no longer true (it has captions now, or it was never the problem the reason names).
- The run reports `errors=0`. The only alert was sent once, on the run that recorded the hold.
- From a blocked host, every video in a playlist would be held on one run.

## Root Cause

The hold is a write that removes the row from every future run, and it was about to be keyed on a classification with two unexamined failure directions.

- **The evidence was a name.** An error class from a library is a claim by its author about why the call failed. Reading `node_modules/youtube-transcript/dist/esm/index.js` showed one `throw` site reached by several distinct causes.
- **The evidence had no age.** "No caption tracks" was treated as a property of the video. It is a property of the video at the moment of the fetch.

Neither is visible in tests that inject the classification directly: a stub that says `captionsDisabled: true` is always right.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** Missing feedback, by design. A permanent outcome exists to stop the weekly alert, so it also removes the one signal that would report a wrong classification. The cost of an error moves from "noisy every week" to "silent forever", which is the direction `empty-output-silent-degradation-2026-04-11.md` warns about.

## Rule Scope

- **Applies when:** an outcome is recorded that later runs treat as final (a hold, a skip list, a tombstone, a "dismissed" flag), and the evidence for it comes from outside the codebase: a library's error, a remote page, an API field.
- **Inverts or does not apply when:** the outcome is re-evaluated on every run, or the evidence is a fact the codebase computes itself from input it already holds (a title that does not match the body's title rule cannot start matching next week). An `unrecognized-title` hold needs no age gate.
- **The retryable direction has a cost too:** an ambiguous row that is never promoted errors every run. A gate that can only say "not yet" needs a bound (here, the age threshold) or it recreates the weekly noise the permanent outcome was built to remove.
- **Sibling docs:** `guessed-natural-key-on-unreadable-input-2026-10-06.md` (why a full re-read needs a permanent outcome at all; this entry is the failure direction of that outcome), `tri-state-return-for-pipeline-outcomes-2026-04-13.md` (ok / error / held as a discriminated outcome), `shared-source-row-level-attribution-2026-04-23.md` (characterize the live input before trusting a filter).

## Solution

Three conditions now stand between a library error and a `no-captions` hold.

1. **The library's error is an unconfirmed report.** `defaultFetchTranscript` translates `YoutubeTranscriptDisabledError` into a local `CaptionTracksMissingError`, which carries no verdict.
2. **A second, positive reading confirms it.** `readCaptionsDisabled` returns true only when the watch page shows status `OK`, the requested video's own details, stream data, and no caption tracks. Every other shape, including a confirmation that itself fails, is an ordinary retryable `TranscriptionError`.
3. **The reading must be old enough to be stable.** The orchestrator holds only when the playlist entry is at least `CAPTIONS_GRACE_DAYS` (7) old. A younger video stays a retryable error.

The hold needs both the confirmed flag and the age. The threshold is `CAPTIONS_GRACE_DAYS` in `src/pipeline/orchestrator.ts`, and the check is the `TranscriptionError` handler in `processPlaylistVideo` in the same file.

## Prevention

**Code-level:** each condition has a test that fails when the condition is removed, checked by mutation: the unconfirmed-report and failed-confirmation cases and the stream-data condition in `src/pipeline/services/TranscriptionService.test.ts`, and the recently-published case in `src/pipeline/orchestrator.test.ts`. Write the classifier's tests per failure direction, one condition varied at a time; a fixture that fails two conditions at once tests neither.

**Process-level:**

- Before writing a permanent outcome, ask two questions of its evidence: *who is asserting this, and what did they actually check?* and *can this be true now and false later?* Read the library's throw sites; do not trust the class name.
- When a slice's Gotchas already name an ambiguity ("a blocked fetch can look like 'transcript disabled'"), run the ten-line live spike before implementing. Here it took one command and showed a third cause the Gotcha had not listed.
- A permanent outcome with no release command makes every wrong classification a manual database edit. Ship the release path with the outcome, or record its absence as a known-weak spot in the PR.

**Recurrence:** this is another `silent production degradation` entry under `patterns/`, and the nearest is `guessed-natural-key-on-unreadable-input-2026-10-06.md`: both end with valid-looking output hiding a lost input. That entry's defect was a guessed key; this one's is a final outcome recorded on evidence nobody checked. The mechanism that catches the next instance of this one is the set of per-condition tests named under Code-level.

## Planning / Calibration Notes

- **What widened the work:** the caption classification. The issue budgeted it as "`TranscriptionError` gains a way to tell"; it became a second fetch, a page parser, and an age gate, and it drew three of the four findings fixed after review.
- **What tightened the work:** the live spike against a known captions-off video, an unavailable ID, and a captioned video, run before any code.
- **Future planning adjustment:** in `/prd-to-issues`, a slice that introduces a permanent outcome should carry an acceptance criterion for the wrong-classification direction ("if X is only apparently true, then … shall not hold"), not only for the correct one.

## Related

- Issue #131, PR #142, PRD #127 (Rabbit Hole "Captions blocked from GitHub Actions").
- Upstream reports of blocked fetches reading as "transcript disabled": `Kakulukian/youtube-transcript` issues #43, #54, #55.

## Shelf Life

The principle is evergreen. The specifics expire when the pipeline stops using `youtube-transcript` for captions, or when a `held:release` command exists and a wrong hold becomes cheap to undo.
