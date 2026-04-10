---
date: 2026-04-10
category: patterns
problem_type: cross-slice contract verification
components: [pipeline, prd-to-issues, execute, pre-merge]
technologies: [effect, github-issues]
severity: high
volatility: stable
---

# Boundary map drift between slices

## Problem

A closed slice can claim Produces it didn't actually ship at the declared path or shape. Downstream slices consume those claims months later and either block or silently expand scope to fill the gap. Nothing in the delivery pipeline verifies that a slice's declared Produces match its actual exports before the slice is marked closed.

## Context

Issue #8 (Pipeline Orchestrator + CLI + Alerts) listed these under Consumes:

- `From #2: src/pipeline/services/ScraperService.ts → EgovScraper Layer`
- `From #2: src/pipeline/services/SummarizationService.ts → SummarizationService Layer`

Both claims were wrong. Slice #2 actually delivered:

- `ScraperService.ts` — only the pure function `parseEgovListingHtml`, no `Context.Tag`, no Effect import at all
- `SummarizationService.ts` — only the pure helper `verifyAmounts`, same story

Nothing in the slice-close gate caught this, because #2's tests all passed and its PR merged cleanly. The gap wasn't discovered until `/execute` on #8 started trying to compose services that didn't exist. The slice had to absorb two unplanned layer-wrapping commits (`70940d8 wrap EgovScraper`, `c3b0254 wrap SummarizationService`) before it could do its actual job.

## Symptoms

- Downstream slice's first implementation commit is "wait, the thing I'm consuming doesn't exist in the shape I expected"
- Downstream slice's PR description includes a "scope expansion" note flagging that part of an upstream slice's boundary map wasn't actually delivered
- Grep for an imported symbol from the Consumes list returns zero hits in the upstream slice's actual code
- The upstream slice's PR merged weeks or months ago, so fixing the boundary map retroactively feels pointless

## Root Cause

There is no pipeline step that verifies a closed slice's Produces section against its actual exports. The chain is:

1. `/prd-to-issues` generates boundary maps from the PRD shape — the Produces list is an *intent*, not a verified contract
2. `/execute` ships code that usually matches the intent but occasionally doesn't (developer scopes down, ships a helper, plans to wrap it later, forgets)
3. `/pre-merge` reviews the diff against the boundary map but doesn't statically verify that every declared Produces symbol actually exists at the declared path
4. Slice merges, boundary map is now stale but unmarked
5. Months later, downstream slice trusts the stale map

The failure is a **missing feedback loop**: slice-close doesn't close the loop back to boundary-map correctness, so stale claims persist silently.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** The delay between "slice #2 closes" and "slice #8 starts consuming #2's claims" is weeks or months. By the time the gap is discovered, the original author has moved on, the reasons for scoping down are forgotten, and retrofitting the upstream slice's boundary map is awkward. The missing feedback loop means every closed slice accrues a small probability of silent contract drift, and the cost compounds across the PRD.

## Solution

Two interventions — both cheap, both orthogonal, and each catches a different failure mode:

**1. Add a boundary-map verification step to `/pre-merge`.** For every `Produces` entry in the PR's slice issue, check that the declared symbol exists at the declared path. A ripgrep + tsc pair can verify `from "#/pipeline/services/ScraperService" { EgovScraper, EgovScraperLive }` actually resolves in the merged tree. Flag mismatches as a pre-merge Concern (Dimension 4). This catches the failure at source, before the slice closes.

**2. Add a `Consumes` verification step to `/execute` Step 0.** Before implementation starts, for every `Consumes` entry in the current slice's boundary map, check that the symbol exists at the declared path. If it doesn't, stop and flag: "slice X's boundary map claims Y but it doesn't exist; need targeted scope-expansion or an upstream fix before proceeding." This catches the failure at the downstream end, even if the upstream slice already merged with a stale boundary map.

Either step alone would have caught the #2 → #8 drift. Having both creates redundant coverage — one for new drift, one for legacy drift.

Separately: when a downstream slice does discover drift (like PR #23 did), file a post-hoc correction issue or comment on the upstream slice to update its Produces list. Never silently absorb the gap without leaving a trail — the next slice to consume from that upstream will hit the same problem.

## Prevention

**Code-level:**
- `tsc` already catches most symbol-drift at build time — the reason it didn't help here is that `/execute` on #8 wasn't *compiling against* #2's code until implementation started. A lightweight "does this import resolve" check could run at `/execute` Step 0, before writing a single line.
- Consider a `scripts/verify-boundary-map.ts` utility that takes a GitHub issue number, parses its Produces/Consumes sections, and checks each symbol exists at the declared path. Invoke from both `/pre-merge` and `/execute` Step 0.

**Process-level:**
- `/pre-merge` Dimension 4 should statically verify Produces, not just eyeball the diff against the map.
- `/execute` Step 0 should verify Consumes before the "Assumptions validation gate." The current Step 0 asks about external services and package versions, but not about internal cross-slice contracts.
- When a slice expands scope to fill a boundary-map gap (as #8 did), the PR description should explicitly link to the upstream slice's Produces section and note which claim was wrong. This creates the breadcrumb that the next maintainer needs.

## Planning / Calibration Notes

- **What widened the work:** two unplanned commits (`70940d8`, `c3b0254`) to wrap pure helpers as Effect Layers. Roughly 20% of the slice's total commits were spent filling a gap that should have been closed months earlier.
- **What tightened the work:** `research.md` specified the Effect Layer shape precisely, so once the gap was identified, the remediation was mechanical.
- **Future planning adjustment:** `/execute` Step 0 should treat the Consumes list as a gate, not a reference. If any Consumes symbol doesn't exist at the declared path, stop and escalate before writing code.

## Actuals Worth Reusing

- **Comparable future work:** any multi-slice PRD where downstream slices consume Effect Layers, API contracts, or database schemas produced by earlier slices.
- **Reusable baseline:** expect ~15–20% scope overhead on a downstream slice when upstream contracts haven't been verified. Budget for it or verify upfront.

## Related

- PR #23 — https://github.com/chrislacey89/civic-mirror/pull/23
- Slice #8 (this one, the consumer)
- Slice #2 (upstream, the source of the drift)

## Shelf Life

When `/execute` Step 0 and `/pre-merge` Dimension 4 both perform static boundary-map verification against actual exports, this lesson becomes a historical footnote. Until then: evergreen for this project.
