---
date: 2026-10-06
category: patterns
problem_type: silent production degradation
components: [pipeline, db, schema, storage, orchestrator, finalsite-scraper, routes]
technologies: [typescript, drizzle, sqlite, turso, effect, tanstack-router]
severity: high
volatility: evergreen
---

# A natural key that is narrower than the source's record merges distinct records

## Problem

A natural key chosen for one source can be too narrow for the next. Meetings were unique on `(body_id, date)`. The school board's site lists every meeting of a day on its own row, so a Board of Finance meeting and the regular meeting that follows it shared a key. Storage treated the second row as more documents for the first and dropped its summary and fiscal decisions. Nothing failed.

## Context

Issue #119, PR #122. The key came from the first source, the Ellettsville eGov portal, where each listing is one document. There, two listings on one date are an agenda and the minutes of the same meeting, and merging them is correct (#27). The Finalsite path was added later and reused the same storage call. On that source a row already groups a meeting's documents, so two rows on one date are two meetings.

Production had ingested one school-board meeting when this was found, because the weekly ingest was failing (#111). The loss was predicted from the live page, not observed.

## Symptoms

- The source lists more rows than the table holds meetings for the same body, and the gap is not explained by re-runs.
- A meeting has documents from two differently named sessions and one summary.
- The run reports `errors=0`. The summary for the merged row was generated and then discarded, so the LLM cost is paid.
- A duplicate check that groups on the key reports nothing, because the key is what merged them.

## Root Cause

Two things combined.

1. **The key encoded an assumption about one source: one meeting per body per day.** Nobody had tested it against the second source. On the live school-board page, 155 dated rows with documents fall on 120 dates. 26 dates repeat, and on 20 of them at least two rows have their own agenda or minutes.
2. **The write merges on key conflict by design.** `db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md` made the write idempotent on the key, and #27 made a conflicting write attach its documents. Both are right when the key is right. Neither can tell "the same record again" from "a different record with the same key".

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** Missing feedback. A merge-on-conflict write turns a key collision into a successful write, so the collision that would have shown the key was too narrow never surfaces. The only place the gap is visible is a count of source rows against distinct keys, and nothing computed it.

## Rule Scope

- **Applies when:** a write is idempotent on a natural key and merges on conflict, and a new source (or a new kind of row in an existing source) is routed to it. Check the key against that source before the first full ingest.
- **Inverts or does not apply when:** the source's rows are parts of one record, as eGov's are. Widening the key there would split one meeting into an agenda-only meeting and a minutes-only meeting. The session is empty for those sources for that reason.
- **Applies to the new key part as well:** whatever is added to widen the key is itself a key field. It needs the treatment `guessed-natural-key-on-unreadable-input-2026-10-06.md` requires: no shared fallback value, and tests in both directions.
- **Sibling docs:** `guessed-natural-key-on-unreadable-input-2026-10-06.md` (a key field that could not be read was guessed), `db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md` (enforce the key in the schema), `shared-source-row-level-attribution-2026-04-23.md` (characterize the live input before trusting a filter).

## Solution

`meetings.session` holds a slug of the school-board row label, and the unique index is `(body_id, date, session)`. Sources whose rows are single documents leave it empty and keep merging by date.

**Before:**
```typescript
uniqueIndex("meetings_body_id_date_unique").on(table.bodyId, table.date),
```

**After:**
```typescript
uniqueIndex("meetings_body_id_date_session_unique").on(
	table.bodyId,
	table.date,
	table.session,
),
```

Four decisions followed from the data, not from the schema change:

- **The existing `meeting_type` could not be the key part.** It maps "Board of Finance", "Public Hearing" and "Regular" all to `regular`, and collides on 25 of the 26 dates.
- **The start time stays in the slug.** 2020-09-21 has "Public Hearing 4:00 PM" and "Public Hearing 7:00 PM".
- **A relabelled row is the same meeting.** The label is editable by the district, and rows stored before the change have an empty session. Before inserting, storage reuses a same-day meeting that already holds one of the incoming documents.
- **A label that slugs to nothing is held, not stored.** An empty slug is the value that merges by date, so storing under it would bring the original failure back for that row.

## Prevention

**Code-level:**

- `src/pipeline/services/StorageService.test.ts`, "stores two sessions on one date as two meetings, each with its own summary": fails if the key stops separating same-day sessions.
- `src/pipeline/orchestrator.test.ts`, "stores two same-named Finalsite rows that share a date under sessions told apart by start time": fails if the slug loses the part that tells the 2020-09-21 pair apart, even if the expected literals are updated with it.
- `src/pipeline/orchestrator.test.ts`, "holds a Finalsite listing whose type cell has no letters or digits…": fails if a blank label is stored under the shared empty session.
- These catch a regression of this key. They do not catch the next source with the same shape. The mechanism that came closest is the "date readers never guess" test in `src/pipeline/dates.test.ts`, which forces every date reader to be listed. It covers `dates.ts` only, and the session slug lives in `orchestrator.ts`. Moving key derivation into one module under that test was left out of PR #122 because the branch had already been reviewed.

**Process-level:**

- Before the first full ingest of a source, parse the live listing and compare the number of rows with the number of distinct keys. Explain every repeated key by reading the rows: an exact duplicate, parts of one record, or distinct records. For the school board the three counts were 1, 6 and 20 dates. This is one script and one fetch.
- When a key changes, search for everything that restates it: verification queries, scripts that select by it, URLs built from it, and docs. `verify-27.ts` still grouped by `(body_id, date)` after the schema changed and would have reported every legitimate same-day pair as a duplicate. Review found it; the author's search for the key had matched comments and missed the SQL.
- When a key gains a part, decide what a reference that omits the part resolves to, and test it. The meeting URL with no session first shipped with an ordering that did not match its own comment.

## Planning / Calibration Notes

- **What widened the work:** the issue asked for a decision about the key. Building it took six commits, then five more after review. The schema change was the small part. The read side (the meeting URL, four link sites, the delete script) and the one row already in production each needed their own handling.
- **What tightened the work:** replaying the live page through the real storage layer into a scratch database. One run gave the expected count (154 meetings from 155 rows), showed the write was stable on a second run, and showed the pre-existing row was reused.
- **Future planning adjustment:** a change to a natural key is a read-path change as well. `/write-a-prd` should list every place a record is addressed by its key before sizing it.
- **Deploy order:** migrations in this repo are applied by hand with `pnpm db:migrate`. A migration that adds a column the new code selects has to reach production before the code does. This one was written to be safe to apply first: a column with a default, and an index replaced by a wider one.

## Actuals Worth Reusing

- **Comparable future work:** routing a new source to an existing idempotent write, or widening any natural key.
- **Reusable baseline:** eleven commits and two review rounds for one added key column, with about half of the hand-written lines in tests.

## Defect Classification

**Origin phase:** Design error. The key was specified for one source and inherited by another.
**Fix type:** Correction for the school-board path. The eGov and YouTube paths are unchanged by design.

## Key Decision

**Decision:** Widen the key with a slug of the source's own row label, start time included.
**Rationale:** It is the only field on the page that is unique on every repeated date.
**Alternatives considered:** The three-value `meeting_type` (collides on 25 of 26 dates). The label with the time stripped (collides on 2020-09-21). A document ID (not known for a row until a document is posted, and minutes are added later).
**Revisable:** Yes. The label can be edited by the district. The document-overlap check covers a relabel that keeps at least one document. A row that is relabelled and has every document replaced on the same day would store twice.

## Related

- Issue #119, PR #122
- Issue #115 and PR #116, the guessed-date failure that prompted the check
- Issue #27 introduced merging sibling listings by date
- Issue #111, the failing ingest that kept this from reaching production
- `docs/solutions/patterns/guessed-natural-key-on-unreadable-input-2026-10-06.md`
- `docs/solutions/patterns/db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md`

**Pattern clustering.** This is the fourth entry in `patterns/` with `problem_type: silent production degradation`, and the second about the meetings key. It is the same pattern as `guessed-natural-key-on-unreadable-input-2026-10-06.md`: a write that merges on key conflict reports success when two different records arrive with one key. There the key was guessed; here it was read correctly and was too narrow. The mechanisms that ship with this entry are the three tests under Prevention.

## Shelf Life

Evergreen — no expiration condition.
