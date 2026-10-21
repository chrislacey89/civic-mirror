---
date: 2026-10-20
category: devops
problem_type: deploy order depends on a hand-applied migration that nothing checks
components: [drizzle/, src/db/check-migrations.ts, src/db/migration-status.ts, package.json build]
technologies: [drizzle-kit, drizzle-orm libsql migrator, Turso, Vercel]
severity: high
volatility: stable
---

# A hand-applied migration must reach production before the code that reads it

## Problem

Vercel deploys every merge to `prod`. Migrations reach production only when someone runs `pnpm db:migrate` by hand. Code that selects a column production doesn't have yet returns 500 on every page that reads that table, and nothing in the deploy path knew a migration was missing.

## Context

On 2026-10-06, PR #122 merged before its migration ran. Every meeting page returned 500 for about 16 minutes, until revert PR #128 deployed. The warning was in the PR body and in chat, and it was still missed. `natural-key-narrower-than-source-record-2026-10-06.md` recorded the deploy order as a note ("a migration that adds a column the new code selects has to reach production before the code does").

On 2026-10-20, PR #208 (migration 0009: `summary_rounds`, plus `summaries.status` and three more columns) went the safe way. Its read queries select `summaries.status`, so merging first would have repeated the outage.

## Symptoms

- After a merge, every page that reads a table returns 500, with a libsql error naming a column that doesn't exist.
- `drizzle-kit migrate` printed `injected env (0) from .env.local,.env` and then `migrations applied successfully!`. The `0` reads like "it found no credentials", but the migration did reach production. Its output can't tell you *which* database it touched, so check the database itself.

## Root Cause

The deploy order was a rule held in people's heads and in PR prose, with no feedback in the path that runs. The merge triggers the deploy automatically, while the migration waits on a human remembering. Two separate actions have to happen in order, and only one of them is automated.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** Missing feedback. The deploy has no signal that the database is behind the code, so a missed step shows up as a production outage, not as a failed build.

## Rule Scope

- **Applies when:** migrations are applied by hand (or by any step separate from the deploy), the deploy is triggered by merge, and the new code reads schema the migration adds.
- **Inverts or does not apply when:** the migration removes or renames something the *old* code reads. There, migrating first breaks the code still live. The order flips (deploy code that no longer reads it, then migrate), and this build check would wrongly block the code deploy. Use an expand/contract sequence across two PRs for that case.
- **Sibling docs:** `patterns/natural-key-narrower-than-source-record-2026-10-06.md` (the first recording, as a deploy-order note).

## Solution

**Procedure that worked for #208, before merge:**

1. Read the history first. Compare `__drizzle_migrations.created_at` against `drizzle/meta/_journal.json` `when`. On 2026-10-06 a migration's tables existed with no history row, which would have made `migrate` fail partway. For #208, 0000–0008 matched one for one.
2. Run `pnpm db:migrate` from a checkout of the PR's head commit. If the PR branch is checked out in another worktree, `gh pr checkout` refuses. Fetch `pull/<n>/head` and use `git switch --detach` instead.
3. Verify against the database, not the tool's output: history rows went 9 → 10, the new table and columns exist, and the existing rows took the column default (`published` × 36).
4. Load the live site on the *old* code (`/`, a body list, a meeting page). An add-only migration has to leave the running code working.
5. Merge.

**Mechanism:** `pnpm build` now runs `src/db/check-migrations.ts` before `vite build`. It compares production's history with the journal using drizzle's own rule (`drizzle-orm/libsql/migrator.js`: an entry is pending when its `when` is newer than the newest applied `created_at`). A production build (`VERCEL_ENV=production`) with anything pending exits 1, so Vercel keeps serving the previous deployment. Other builds print the pending list and continue. With no database URL it prints a skip line and continues.

## Prevention

**Code-level:** the build check above, with `src/db/migration-status.test.ts` pinning the pending rule. A merged-but-unmigrated PR now fails its production deploy instead of taking the site down. The fix is still to migrate, then redeploy.

**Process-level:** the build check makes merging first safe, but the procedure above is still the order to follow. A failed production deploy also blocks any unrelated fix queued behind it.

## Key Decision

**Decision:** Fail only the production build, and skip when no database URL is present.
**Rationale:** Preview builds of a migration PR run before the migration does, so failing them would block reviewing the PR. Local and CI builds have no production credentials.
**Alternatives considered:** Running migrations in the build. Rejected because it would apply schema changes on any merge with no human in the loop, which is a bigger change than this lesson supports.
**Revisable:** Yes. If migrations move into CI or the deploy, delete the check.

## Unverified

Whether Vercel exposes `DATABASE_URL` to the *build* step as well as the runtime has not been confirmed. If it doesn't, production build logs show `[check-migrations] skipped: no DATABASE_URL (production build: the check did not run)` and the mechanism does nothing. Check the first production build log after this merges for `[check-migrations] up to date`.

## Related

- PR #122 (the outage), PR #128 (the revert), PR #208 (migrated first)
- `patterns/natural-key-narrower-than-source-record-2026-10-06.md`

## Shelf Life

When migrations run automatically as part of the deploy, this entry and the build check are both obsolete.
