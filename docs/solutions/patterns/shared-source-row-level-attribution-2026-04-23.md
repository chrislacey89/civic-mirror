---
date: 2026-04-23
category: patterns
problem_type: ingestion attribution / cross-pollination
components: [pipeline, scraper, orchestrator, composition]
technologies: [effect, typescript]
severity: high
volatility: evergreen
---

# Shared-source queries require row-level attribution filters

## Problem

When a single external query returns rows from multiple logical owners, the ingestion pipeline must enforce **per-owner attribution at the row level** before storage. Query-parameter-level attribution (body slug, search type, account id) is not a trustworthy primary key for ownership — the source system is free to aggregate multiple owners' rows behind one query, and every row it returns will look equally valid to a naive pipeline.

## Context

The Ellettsville eGov document center's `searchType=12` query returns every "minutes" PDF on the portal, regardless of which governing body produced it. Three bodies in the pipeline's config shared `egovSearchType="12"`: `ellettsville-town-council`, `ellettsville-plan-commission`, and `monroe-county-commissioners`. The orchestrator stored every row returned by that query under whatever `body.slug` it was iterating, so a Reorganization Board meeting got persisted as a Town Council meeting, a Plan Commission meeting, and a Monroe County meeting simultaneously.

The bug invalidated the premise of the product: Civic Mirror is body-level intelligence (per-body feeds, per-body spending dashboards, "what did Town Council decide?" queries). Every downstream view was wrong if row-level attribution was wrong. It also blocked the #25 two-year backfill, because running a backfill with the current scraper would multiply wrong-attribution rows across two years of history.

## Symptoms

- A body's feed shows meetings that don't belong to it (e.g. Town Council feed shows "Reorganization Board Meeting…" rows).
- The DB's "most recent meeting per body" query returns dates from a sibling body's activity, not the body's own.
- Per-body spending dashboards and aggregates reflect blended data.
- `SELECT COUNT(*) FROM meetings WHERE body_id = X` grows with every run even when no new meetings were published by that body (because sibling bodies *did* publish).
- Downstream alerts that depend on body attribution (e.g. zero-results anomaly at 30 days without content) fire incorrectly — either silently suppressed (because a sibling's rows got misattributed and make the body look active) or over-eagerly fired (because the real body's rows got stored under a sibling).

## Root Cause

The original composition assumed that the scraper's query parameters identified a body's content: "if I query with `searchType=12` for the Town Council body, I get Town Council rows." That assumption was never checked against the actual portal — the portal aggregates all "minutes" regardless of body, and the pipeline had no row-level filter to compensate. The scraper returned 25 rows per page 1 fetch; of those, only 20 were Town Council. The other 5 belonged to Reorganization Board (4) and Redevelopment Commission (1).

The underlying structural problem is that **the scraper's query contract was confused with a body-ownership contract**. The scraper's job is "fetch a page"; the composition root's job is "attribute rows to bodies." Those two concerns collapsed into one before this fix, because the pipeline was designed around the happy case where each body had a dedicated endpoint.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** The feedback loop from "wrong-body row inserted" to "operator notices" is the rate at which a human opens the per-body surface (landing feed, dashboard, detail page) *and is familiar enough with the body's actual output to spot a row that doesn't belong*. For a solo developer running a scheduled cron, that's "occasionally, if I happen to click on that body." The bug in #35 had been shipping for multiple weeks before it surfaced.

## Solution

Three principles, applied together.

**1. Attribution is a composition concern, not a scraper concern.** The scraper stays body-agnostic: it fetches a page and parses rows. The composition root (in this project, `src/pipeline/composition.ts`) owns the policy decision of "which rows count for which body." Putting the filter in the scraper would mean every caller shares the filter, and the scraper becomes body-aware — which breaks reuse and hides the coupling.

**2. Row-level filter at the orchestration boundary, before any downstream work.** Use an optional per-body pattern that the orchestrator applies to incoming rows before download, summarization, or storage runs. Filtering before the expensive stages (and before the crawl-delay budget is spent on the row) is the whole point.

```typescript
// BodyConfig gains an optional pattern
type BodyConfig = {
  slug: string;
  name: string;
  egovSearchType?: string;
  /**
   * Required when egovSearchType is shared across multiple bodies.
   * Listings whose title doesn't match are silently skipped — they
   * belong to a sibling body. See #35.
   */
  egovTitlePattern?: RegExp;
  // ...
};

// Orchestrator wires it into the existing per-item iteration hook
return yield* iterateWithAlertRecovery(body, listingsResult.listings, {
  processItem: (listing) => processEgovListing(body, listing, config),
  delayBetweenItemsMs: config.crawlDelayMs,
  shouldProcess: titlePattern
    ? (listing) => titlePattern.test(listing.title)
    : undefined,
});
```

**3. Prefer existing iteration primitives over new abstractions.** The `iterateWithAlertRecovery` helper already had a `shouldProcess` hook for exactly this class of "skip-silently-based-on-predicate" concern. The fix was a 4-line wiring change inside an existing hook, not a new module. When a pipeline already has a helper with a sibling concern, reach for it before writing a new filter abstraction. Re-check existing Effect combinators / iteration hooks before adding a parallel mechanism.

## Prevention

**Code-level:**

- Any body whose source query is *shared* with another body must carry a row-level attribution filter. Treat this as a requirement, not a convention. If the filter is optional in the type system (to preserve backwards compatibility for dedicated-endpoint bodies), enforce it via a code-review check: "If this body's `egovSearchType` (or equivalent) matches another body's, does it carry an `egovTitlePattern`?" Add this to the `/pre-merge` Dimension 9 "fix completeness" pattern search for any PR that adds a new body.
- The filter should run **before** the rate-limiter delay, not after. Otherwise a long page of mostly-wrong-body rows burns the crawl-delay budget on rows that will be dropped. Verify the filter is wired into the pre-delay `shouldProcess` hook, not a post-download discard.
- For every new row-returning scraper method, write a test that seeds the input with **rows from the wrong owner** and asserts they don't reach downstream stages. A test that only seeds correct rows ("Town Council rows go to Town Council") misses the defect entirely; the defect is about wrong rows getting through.

**Process-level:**

- **`/research` for ingestion features must characterize the input distribution, not just the API contract.** For each scraper / feed / webhook the project plans to consume: what does a single query actually return, and is every row owned by the caller? The question "how many rows does page 1 contain and how many belong to the caller" must have a concrete answer with evidence (a fetched page, a sample API response). "The docs say it returns Town Council minutes" is not sufficient; the docs are often wrong or silently underspecified about shared feeds.
- **`/write-a-prd` for ingestion features: add an omitted-activities scan item** — "Does any data source in this PRD aggregate rows from multiple logical owners behind one query?" If yes, the PRD must name the attribution mechanism (title pattern, metadata field, URL pattern, etc.) before decomposition.
- **`/prd-to-issues` for ingestion slices: whenever a slice introduces a new body or a new scraper**, its boundary map should include an explicit row-level attribution field if the source is shared, and an acceptance criterion that verifies wrong-owner rows are dropped.

## Planning / Calibration Notes

- **What widened the work:** having to manually audit the live eGov page 1 to confirm the chosen regex matched real titles. That check took ~5 minutes but is easy to skip — and if skipped, the filter could silently match zero rows (the "Plan Commission" case currently has zero matches on page 1, which is indistinguishable from "filter is broken" without external context). Budget the live-data audit as part of any attribution-filter slice.
- **What tightened the work:** the `iterateWithAlertRecovery.shouldProcess` hook already existed in the orchestrator, from an earlier slice. Discovering it collapsed the expected implementation from "add a filter function + refactor the per-body loop + update tests" down to "add one optional field + 4 lines of wiring + one new test." Grep existing pipeline helpers before designing a new filter path.
- **Future planning adjustment:** for any PRD that ships a new ingestion source, `/research` should produce an "input distribution" note (sample page, owner counts) that `/write-a-prd`'s completeness scan can consult. The research-time cost is small and the bug-prevention payoff is structural — this defect class is latent in every shared-feed integration.

## Actuals Worth Reusing

- **Comparable future work:** any slice that adds a new ingestion body or a new scraper. Specifically: if the project ever adds more Ellettsville-area bodies (Redevelopment Commission, Parks & Rec Board, BZA) to the eGov scraper, each one needs an `egovTitlePattern`. Also relevant to a future RSS feed consumer, webhook subscriber, or Slack ingestion where one channel might aggregate multiple owners' posts.
- **Reusable pattern:** the "optional-per-owner-predicate + `shouldProcess`-at-iteration-hook" shape from `src/pipeline/orchestrator.ts`. Copy the ~4-line structure and the type-field addition into whatever the next attribution slice needs.
- **Reusable baseline:** with the existing iteration hook in place, an attribution-filter slice is a ~1-hour task (type field, composition config, one test, live-data audit). If it's taking significantly longer, the pipeline probably needs the iteration hook first — budget that refactor separately.

## Defect Classification

- **Origin phase:** Specification error. The original `composition.ts` assumed that `egovSearchType` identified a body's rows. That assumption was never checked against the portal's actual behavior — no one queried page 1 during shaping and saw that the rows were multi-body. `/research` did not characterize the input distribution because the skill, at that time, did not require it.
- **Fix type:** Correction. The app-level behavior that accepted any row is removed. The external cause (portal aggregating multi-body rows) is an unchangeable constraint; the correct attribution boundary is in the application, which is where the fix lives. Historical misattributed rows remain in the DB and will be cleaned up by #25's clean-slate re-ingest; that's a data-cleanup task, not a code fix.

## Secondary observation: defensive workarounds that do double duty

In the fix for #35, Monroe County Commissioners received `egovTitlePattern: /^Monroe County/i`. That pattern serves **two** distinct purposes:

1. Row-level attribution (Monroe's rows, not Ellettsville's sibling bodies' rows) — the #35 contract.
2. A compensating safety net for a separate latent bug: `EGOV_BASE_URL` is a single config value wired into one scraper layer, so Monroe currently queries the Ellettsville portal (wrong portal entirely). The `/^Monroe County/i` pattern matches zero rows on the Ellettsville portal, which is the *correct zero-storage behavior* while the URL is wrong — but only by accident of the pattern.

The risk pattern: if a future dev wires Monroe's real portal URL (tracked as #41) without understanding the pattern's double-duty role, the pattern will continue filtering out real Monroe rows once they start flowing. The workaround's role is only documented in a code comment.

**Principle for the project:** when a fix uses a defensive predicate (regex, filter, early-return) that happens to compensate for a *separate* unresolved bug, file the separate bug immediately so the coupling lives in GitHub state, not just in a code comment. See #41 as the mitigation for this specific case.

**For future fixes:** before shipping a slice whose implementation "also happens to" neutralize another known gap, write down the second gap as its own issue in the same commit / PR. Code comments alone decay faster than GitHub state.

## Key Decision

**Decision:** Filter in the orchestrator's iteration hook, not in the scraper.

**Rationale:** The scraper's contract is "fetch a page and parse rows." Body attribution is a composition concern — it depends on which body the orchestrator is currently running, which the scraper has no business knowing. Putting the filter in the scraper would require either a body-aware scraper (breaks the scraper's reuse) or a body-param on every scrape call (leaks the composition concern into the scraper's API). Filtering in the orchestrator keeps both layers single-purpose.

**Alternatives considered:**

- *Filter in the scraper.* Rejected — makes the scraper body-aware and couples fetch to attribution. If a future caller wants the unfiltered page for debugging or an alternative attribution strategy, they'd have to go around the scraper.
- *Post-storage scrub (insert everything, then delete wrong-body rows).* Rejected — would still run the expensive download / extract / summarize stages for wrong-owner rows, burn the crawl-delay budget on them, and produce noisy intermediate storage state.
- *Add a composite index on `(body_id, title_prefix)` in the DB and rely on ON CONFLICT to catch it.* Rejected — prefix matching in SQLite is clumsy, and this moves the attribution check from a declarative config (regex per body) to a schema concern. The regex-at-composition-boundary is the cleanest place for this.

**Revisable:** Yes, if the project ever adopts a richer metadata field from the scraper (e.g., a dedicated `body` field in the eGov portal HTML — unlikely, but possible). At that point the filter could move from title-matching to metadata-matching, or the filter could be dropped entirely for bodies whose source already provides attribution.

## Related

- `docs/solutions/patterns/db-enforced-natural-keys-for-idempotent-pipelines-2026-04-23.md` — sibling compound from the same week; both patterns are about enforcing ingestion correctness at the right layer (DB-level natural key for write-side idempotency, composition-level filter for row attribution). Together they form the backbone of "ingestion correctness invariants must be enforced in code, not documented in prose."
- Issue #35 — https://github.com/chrislacey89/civic-mirror/issues/35 (the cross-pollination bug)
- PR #40 — https://github.com/chrislacey89/civic-mirror/pull/40 (this fix)
- Issue #41 — https://github.com/chrislacey89/civic-mirror/issues/41 (the Monroe per-body URL follow-up; named in the Secondary observation above)
- Issue #36 — https://github.com/chrislacey89/civic-mirror/issues/36 (zero-results anomaly alert accuracy; partially resolved by this fix because bodies now report their real last-meeting date)
- Issue #25 — https://github.com/chrislacey89/civic-mirror/issues/25 (2-year backfill; unblocked from the attribution side by this PR, still gated on #27 date parsing)

## Shelf Life

Evergreen. The specific eGov-portal case ends when every body has a dedicated endpoint (which may never happen — municipal portals rarely reorganize). The broader pattern — "shared external queries require row-level attribution at the composition boundary" — applies to any ingestion architecture and any source that aggregates multi-owner rows behind a single query interface. The process recommendations for `/research` and `/write-a-prd` apply to any future ingestion feature in any downstream project using this skill pack.
