---
date: 2026-04-23
category: patterns
problem_type: duplicate rows from re-runnable ingestion writes
components: [pipeline, db, schema, storage]
technologies: [drizzle, sqlite, turso, effect]
severity: high
volatility: evergreen
---

# DB-enforced natural keys for idempotent pipeline writes

## Problem

A scheduled ingestion pipeline that re-scrapes the same external source every run will accumulate duplicate rows in every downstream table unless the storage layer has a **DB-enforced natural key** on the row's identity fields. An application-level "check then insert" guard alone is insufficient — it's racy across concurrent runs, it's silently bypassable by any other writer, and it's a convention rather than an invariant.

## Context

Issue #37 surfaced on the Ellettsville Town Council feed: each weekly cron run was producing a fresh `meetings` row for every meeting already on eGov's page-1 listing, so the Feb 4 meeting appeared three times in the landing feed and the Jan 20 meeting twice. The same duplicate-per-run behavior cascaded through `documents`, `summaries`, `fiscal_decisions`, and `budget_discussions` because each stage inserted unconditionally.

The bug blocked two separate lines of work: the scheduled Sunday cron couldn't run safely, and the #25 two-year backfill couldn't proceed without first wiping the DB — and wiping would have to happen after *every* backfill attempt until the duplicate-on-insert problem was fixed.

PR #38 introduced `uniqueIndex("meetings_body_id_date_unique")` and `uniqueIndex("transcripts_meeting_id_source_unique")` at the Drizzle schema level, and added an application-level short-circuit at the top of `storeMeetingTransaction` and `storeTranscript` that returns the existing row when the natural key already exists. The weekly cron and future re-runs are now safely idempotent across all six pipeline-written tables.

## Symptoms

- Row counts grow linearly with run count on the same input (e.g. `meetings` doubles after the second run even though nothing new was published)
- Foreign-key-referenced tables accumulate duplicates too — same meeting cited in two separate `summaries` rows, same ordinance linked from two `documents` rows
- Dashboards that aggregate across the table (e.g. spending-per-month sums) inflate by the duplication factor
- Dry-run / `processed=N errors=0` reports look fine because inserts aren't failing — they're succeeding too often
- `SELECT bodyId, date, COUNT(*) FROM meetings GROUP BY bodyId, date HAVING COUNT(*) > 1` returns rows after a second run; this is the canonical verification query for any ingestion fix in this shape

## Root Cause

The original schema modeled `meetings` with an autoincrement `id` primary key and no uniqueness guarantee on `(bodyId, date)`, even though the domain natural key is exactly `(governing body, date)`. The storage stage took the input, inserted a row, and returned the new `id` — it never asked "does this meeting already exist?" The pipeline's external sources (eGov, Finalsite) keep re-publishing the same listings for weeks; every run re-sees them and inserted a new row.

The underlying structural problem is that **natural keys were documented in prose comments but not enforced in the schema**. A comment saying "the composite of (bodyId, date) is the natural key" is a convention. A `uniqueIndex` is an invariant. The production cron can only run safely if the DB itself refuses to create the forbidden row.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** The feedback loop from "duplicate row inserted" to "operator notices" is the rate at which someone opens the user-facing surface. For a scheduled cron that the developer isn't watching, it's a full week per cycle. Each week compounds another round of duplicates and expands the cleanup cost. The defense has to be at insert time, not at read time — a read-side dedupe only masks the problem and makes it harder to spot.

## Solution

The pattern has three parts, and all three must ship together.

**1. Enforce the natural key in the schema.** Use Drizzle's table-level `uniqueIndex` on the natural-key columns:

```typescript
export const meetings = sqliteTable(
  "meetings",
  {
    id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
    bodyId: integer("body_id").notNull().references(() => governingBodies.id),
    date: text().notNull(), // YYYY-MM-DD
    // ...
  },
  (table) => [
    // (bodyId, date) is the natural key. This index turns it into a
    // DB-enforced invariant so the weekly ingestion cron can't produce
    // duplicate meeting rows on re-run.
    uniqueIndex("meetings_body_id_date_unique").on(table.bodyId, table.date),
  ],
);
```

The index is the source of truth. Any future writer — the pipeline, a backfill script, a migration, a one-off repair query — is now constrained at the DB boundary.

**2. Short-circuit at the storage boundary.** The index will *reject* a duplicate insert with a `UNIQUE constraint failed` error, but you don't want the pipeline to treat that as an error. Add a pre-insert check inside the storage transaction and return the existing row's handle:

```typescript
const existing = await tx
  .select()
  .from(schema.meetings)
  .where(and(
    eq(schema.meetings.bodyId, body.id),
    eq(schema.meetings.date, input.date),
  ))
  .get();

if (existing) {
  return { id: existing.id, date: existing.date, bodyId: existing.bodyId };
}
// ...otherwise insert
```

This gives callers a uniform "handle to a stored meeting" return regardless of whether the row was just created or already existed. The guard is defense in depth, not a replacement for the index. If the guard is ever removed or bypassed, the index still prevents corruption; if the index is ever dropped, the guard still prevents most duplicates (modulo races).

**3. Compose the natural key to match the domain.** Not every "uniqueness" guarantee is `(parentId)`. Transcripts on this project legitimately carry *two* rows per meeting — one `captions` and one `whisper` — so the natural key is `(meetingId, source)`, not `meetingId`. The composition question during schema design is: *how many rows can a real domain entity legitimately produce, and what discriminator distinguishes them?* Answer that first, then write the index.

```typescript
uniqueIndex("transcripts_meeting_id_source_unique").on(
  table.meetingId,
  table.source,
)
```

## Prevention

**Code-level:**

- For every new `sqliteTable` definition in `src/db/schema.ts`, require either a `uniqueIndex` on the natural-key columns or an explicit comment stating why the table allows unbounded duplicates. The default should be "pick a natural key" — if no natural key exists, that's a schema-design red flag, not a license to skip the constraint.
- The short-circuit in the storage stage belongs **inside the transaction**, not before it, so the check and the insert are atomic against concurrent writers. A check outside the transaction leaves a race window that the DB index will catch, but noisily — the pipeline will log a unique-constraint error instead of silently returning the existing handle.
- Every new storage method in `StorageService.ts` should follow the same shape as `storeMeetingTransaction` and `storeTranscript`: select-by-natural-key, short-circuit on existence, insert otherwise. Make it the default pattern.
- The canonical duplicate-detection query — `GROUP BY <natural key> HAVING COUNT(*) > 1` — should be kept as a test fixture or a smoke script so any regression is one query away from visible.

**Process-level:**

- `/write-a-prd` for any ingestion or pipeline feature should explicitly ask: *"What is the natural key of each row this pipeline writes, and what does 're-run' mean for each row shape?"* Add this to the omitted-activities scan for pipeline PRDs. Rows written by a scheduled/re-runnable pipeline without a documented natural key are a rabbit hole.
- `/execute` verification for any slice that writes to a new table should include "run the slice twice and verify row counts are stable on the second run." This is a five-second test that catches the entire class of bug.
- `/pre-merge` Dimension 7 (Runtime Initialization) for any PR that adds a new `sqliteTable` should check for: (a) `uniqueIndex` on the natural key, (b) storage-stage short-circuit, (c) migration safety against live data (see below).

## Planning / Calibration Notes

- **What widened the work:** the live Turso DB already contained the very duplicates this change was going to constrain against, so migration `0002` couldn't apply in-place — the `UNIQUE` index creation would have failed on the existing rows. Resolving that added a migration-strategy decision (see Key Decision) and a full DB-wipe + re-seed cycle to the verification path. Budget a migration-strategy conversation whenever a schema-tightening change meets live data; the constraint itself is the easy part.
- **What tightened the work:** the issue template on #37 already named the correct fix shape ("unique constraint on `(body_id, date)`… `onConflict().doNothing()` or query for the existing meeting"), so the code shape didn't require exploration — only the refresh-semantics decision did. Good issue-writing compounds.
- **Future planning adjustment:** `/research` for ingestion features should explicitly characterize the input re-publication pattern of each source. "How often does the same listing reappear in the source's feed, and over what time window?" — the answer to this determines whether idempotency is a weekly concern or a once-a-month concern, and whether skip-on-conflict is sufficient or merge-on-conflict is required.

## Actuals Worth Reusing

- **Comparable future work:** any slice that adds a new pipeline-written table. Specifically: a future `agenda_items` or `public_comments` table, any caching layer that persists external API responses, any materialized-view-like table populated by a recurring job.
- **Reusable baseline:** the index + select-by-natural-key + short-circuit pattern in `src/pipeline/services/StorageService.ts` is ~15 lines of code per table. Budget it as part of the schema PR, not a follow-up; retrofitting it against live data is several times more expensive than shipping it with the original table.
- **Reusable pattern:** the `storeMeetingTransaction` body (short-circuit → insert meeting → insert children) is the template for all future pipeline storage operations. Copy the shape.

## Defect Classification

- **Origin phase:** Specification error. The original schema PR defined the table without a uniqueness constraint on what the block comment called "the natural key." The prose identified the invariant; the code didn't enforce it. The gap between documented and enforced invariants is exactly where this defect class lives.
- **Fix type:** Correction. The `uniqueIndex` + storage guard addresses the root cause — duplicate inserts can no longer occur even if the guard is removed. The deferred refresh semantics (see Key Decision) are a *scope* deferral, not a workaround: the idempotency invariant is fully enforced.

## Key Decision

**Decision:** Ship `skip-entirely-on-conflict` semantics rather than `merge-on-conflict` (attach new documents / summaries / fiscal rows to the existing meeting).

**Rationale:** The immediate goal was to stop the duplicate bleed so the weekly cron and #25 backfill could both proceed. Refresh semantics — "if an eGov agenda is posted three days after the minutes were first scraped, pick it up on the next run" — is a separate problem with its own design decisions: what does "stale" mean, what if the source document *changed* rather than a new one being added, do we preserve the old row or replace it, how do we avoid re-summarizing unchanged content. Bundling that into the duplicate fix would have blown the scope.

**Alternatives considered:**

- *Merge-on-conflict (attach new children to existing meeting).* Rejected — requires a change-detection design for child rows and a de-duplication rule for summaries. Correct eventual direction, wrong first slice.
- *Truncate-and-reinsert per run.* Rejected — loses historical FK relationships (e.g. any user-facing bookmarks to `/meetings/:id` would break on every re-run), burns re-summarization cost every week, and is a worse answer than the simple skip.
- *Check-only in the application layer, no DB index.* Rejected — the invariant is what the DB exists to enforce. Without the index, any future writer (a migration, a repair query, a backfill script) can still produce duplicates silently.

**Revisable:** Yes. The followup refresh-semantics work is tracked as a deferred concern; when a "pick up new documents on re-run" requirement arrives, swap the short-circuit for a merge inside `storeMeetingTransaction`. The index stays as-is.

## Key Decision (migration strategy)

**Decision:** Wipe the live Turso DB and re-seed rather than adding a destructive dedupe preamble to migration `0002`.

**Rationale:** Applying the new unique index to the existing Turso DB would have failed because the DB already contained the very duplicates the constraint rejects. Two paths existed: (a) prepend a "delete duplicate meetings preserving the oldest per `(bodyId, date)`" block to the migration, or (b) wipe and re-seed. The #25 backfill PRD already assumes a clean-slate re-ingest — the live data was throwaway, not production. Wiping kept the migration file a clean schema change and avoided shipping destructive SQL against a table that would otherwise be permanent infrastructure.

**When this generalizes:** wipe-and-reseed is a valid migration strategy only when (1) the data is known-throwaway or (2) a separate backfill plan already exists and is scheduled. If the data is production-significant and no backfill is planned, the migration must own a safe dedupe step (which typically means: select the row to keep per group, re-point FKs, delete the losers, then create the constraint). Don't wipe by default; don't hand-dedupe by default either — make the call based on whether clean-slate re-ingest is already on the roadmap.

**Alternatives considered:**

- *Destructive dedupe preamble in the migration.* Rejected for this case because the backfill plan made it unnecessary work. Would have been the correct answer if live data were production.
- *Skip the index, rely on app-level guard only.* Rejected — violates the whole point of the pattern.

**Revisable:** The strategy is per-migration, not project-wide. Future schema-tightening migrations should re-evaluate based on (a) data volume, (b) whether a clean-slate backfill is planned, (c) whether preserving FK graph is user-visible.

## Related

- `docs/solutions/patterns/boundary-map-drift-between-slices-2026-04-10.md` — same sibling directory; different failure mode (stubs at slice boundaries) but same underlying principle (enforce invariants at the boundary, not in prose).
- `docs/solutions/patterns/empty-output-silent-degradation-2026-04-11.md` — also about pipeline-stage invariants that need to be enforced in code, not conventions.
- Issue #37 — https://github.com/chrislacey89/civic-mirror/issues/37 (the duplicate-meetings bug)
- PR #38 — https://github.com/chrislacey89/civic-mirror/pull/38 (this fix)
- Issue #25 — 2-year selective backfill; was blocked by this bug, now unblocked.

## Shelf Life

Evergreen for the pattern. The specific migration-wipe decision is tied to #25's clean-slate backfill plan, which is a point-in-time condition; future schema-tightening migrations need to re-answer the wipe-vs-dedupe question on their own merits. The core principle — *every pipeline-written table needs a DB-enforced natural-key index and a storage-stage short-circuit* — applies as long as the project has a re-runnable ingestion pipeline, which is indefinitely.
