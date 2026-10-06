---
date: 2026-10-06
category: patterns
problem_type: silent production degradation
components: [pipeline, dates, orchestrator, egov-scraper, finalsite-scraper, alerts]
technologies: [typescript, effect, vitest]
severity: high
volatility: evergreen
---

# A guessed natural key on unreadable input merges records silently

## Problem

A parser that cannot read a field which forms part of a record's natural key must not substitute a plausible value for it. Meetings are unique on `(body_id, date)`. When the date could not be read, the pipeline filled in another date, and every record that hit the same fallback collapsed into one. Nothing failed: `errors=0`, a meeting page rendered, and five summaries were dropped.

A second problem appears when the guess is replaced with "hold the row and alert". If a source serves a permanently unreadable row on every run, the new alert fires forever.

## Context

Issue #115. The eGov portal lists an upload date in a table cell and the real meeting date only inside the title. `extractMeetingDateFromTitle` read the long form ("December 22, 2025") and returned `null` for the numeric form the town switched to ("Town Council Meeting Minutes 03-23-26"). `processEgovListing` then did `listing.meetingDate ?? normalizeEgovDate(listing.date)`. Six sets of minutes uploaded together on 2026-05-14 became one meeting on 2026-05-14.

The fallback was a deliberate choice from #27, with a comment calling the null case "rare; annual reports and similar". It was written when every known title used the long form.

The school-board (Finalsite) path had the same shape: `normalizeFinalsiteDate` returned January 1 of the panel year for a cell it could not match, and January for a month name it did not know.

## Symptoms

- A meeting exists on a date when no meeting took place, usually an upload date or the first of a month or year.
- That meeting has several documents from different real meetings and one summary.
- Expected meeting pages for nearby dates are missing.
- The run reports `errors=0` and sends no alert.
- Two listings uploaded on their own meeting day look correct, which hides the pattern.

## Root Cause

Two decisions combined.

1. **The parser's null was treated as "use the next best date".** A date that is half of a uniqueness key has no next best value. Any substitute is shared by every other row that falls back, so the unique index does what it was built to do and merges them. `db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md` makes the write idempotent on the key; it cannot tell a correct key from a guessed one.
2. **The parser's coverage was fixed at the formats seen on the day it was written.** The source changed format with no notice, and nothing measured how many live rows the parser failed to read.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** Missing feedback. The fallback converted "the parser does not understand this source any more" into valid-looking output, so the one signal that would have reported the format change was consumed inside the pipeline. The delay was five months: uploaded in May, noticed in October.

## Rule Scope

- **Applies when:** the unreadable field is part of a natural key, a join key, or anything the storage layer uses to decide that two inputs are the same record. Dates, slugs, external IDs and owner attribution all qualify.
- **Inverts or does not apply when:** the field is descriptive only. A missing meeting type defaulting to `"regular"` merges nothing. A fallback is also fine when the substitute is unique per row (for example the source's own document ID), because it cannot collide.
- **Applies to the hold as well:** before replacing a guess with hold-and-alert, check whether the source re-serves the same rows on every run. A page-1-only listing ages a bad row out; a source that is re-read in full does not. For the second kind, a row that will never be readable needs its own outcome, or the alert becomes weekly noise that hides the next real failure.
- **Sibling docs:** `empty-output-silent-degradation-2026-04-11.md` (throw, do not log, when a stage produces nothing), `tri-state-return-for-pipeline-outcomes-2026-04-13.md` (when the caller needs a third outcome), `shared-source-row-level-attribution-2026-04-23.md` (characterize the live input distribution before trusting a filter).

## Solution

Readers return `null` for input with no readable date. The orchestrator fails the listing with `UndatedListingError` before any download, and the existing per-listing recovery alerts and continues.

**Before:**
```typescript
// A null from the title parser falls back to the upload date.
const meetingDate = listing.meetingDate ?? normalizeEgovDate(listing.date);
```

**After:**
```typescript
const meetingDate = listing.meetingDate;
if (meetingDate === null) {
	return yield* Effect.fail(
		new UndatedListingError({ title: listing.title, uploadDate: listing.date }),
	);
}
```

The parser was widened for the formats actually on the portal (`M-D-YY`, and a long form with no space after the comma), and both forms now reject days that do not exist.

On the school-board path the same hold applied, with one exception found by running the parser over the live page: 158 of 159 rows parse, and one row is dated `September 2025` (a contract notice, not a meeting). That source is re-read in full on every run, so the row is skipped with a `finalsite.listing.skipped` log line and not counted as an error.

## Prevention

**Code-level:**

- `src/pipeline/dates.test.ts`, "date readers never guess": every function exported from `src/pipeline/dates.ts` must be listed either as a date reader, with a call that hands it undated input and must return `null`, or as not a date reader. A new export fails the test until it is listed, so a new reader cannot be added without stating what it does with unreadable input.
- Tests for a parser that feeds a key need cases in both directions: inputs it must read, and inputs it must refuse. The refusals found on this branch were a four-digit year, an ISO date, a longer hyphenated number, and an impossible day.
- The check does not reach code that derives a key outside `dates.ts`. `processYouTubeVideo` stored `video.publishedAt.slice(0, 10)` as the meeting date, and the `drama:detect` command defaulted `--date` to today; both were found by searching for the shape and fixed in #117.

**Process-level:**

- When a change makes a parser stricter, run it over the live source for every body that uses it and record three counts: read, refused, and refused-forever. The first fix on this branch tightened the school-board reader without that check, and review caught the permanent row only because the reviewer fetched the page.
- In `/execute`'s structural sibling search for a bug of this kind, search for the shape (`?? `, `|| `, or a default return in anything that produces a key), not for the function named in the issue. The issue named one function; the same defect was in a second source and is latent in a third.

## Planning / Calibration Notes

- **What widened the work:** the issue read as a one-function parser fix. It became ten commits and two review rounds, because the fallback itself was the defect and it existed in each source path separately.
- **What tightened the work:** one read-only fetch of each live listing settled questions that reasoning about fixtures could not: which title formats exist, and whether a hold would fire.
- **Future planning adjustment:** for an ingestion bug, `/research` or the first step of `/execute` should fetch the live listing and run the current parser over it before estimating. The count of unread rows is the size of the problem.

## Defect Classification

**Origin phase:** Design error. The fallback was specified and commented; it was the wrong outcome for a key field.
**Fix type:** Correction for the eGov and school-board paths. The YouTube path was corrected separately in #117.

## Key Decision

**Decision:** A month-and-year date cell on the school-board source is skipped with a log line and no alert.
**Rationale:** The row is a notice, not a meeting, and the source serves it on every run.
**Alternatives considered:** Hold and alert like every other unreadable cell, which would have sent the same alert weekly.
**Revisable:** Yes. If the district ever posts a real meeting dated only by month, it would be dropped with only a log line; an alert that fires once per distinct row would be the better shape then.

## Related

- Issue #115, PR #116
- Issue #27 introduced the title-date parser and the fallback
- `docs/solutions/patterns/empty-output-silent-degradation-2026-04-11.md`
- `docs/solutions/patterns/tri-state-return-for-pipeline-outcomes-2026-04-13.md`
- `docs/solutions/patterns/shared-source-row-level-attribution-2026-04-23.md`
- `docs/solutions/patterns/db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md`

**Pattern clustering.** This is the third entry in `patterns/` with `problem_type: silent production degradation`, after the empty-output and placeholder-stub entries. All three are the same pattern: a stage substitutes something valid-looking for a result it could not produce, and the run reports success. The earlier two were caught by output guards at the stage boundary. This one needed a different mechanism, because the output here was well-formed; it is the test named under Prevention.

## Shelf Life

Evergreen — no expiration condition.
