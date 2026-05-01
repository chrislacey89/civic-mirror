---
date: 2026-05-01
category: testing-patterns
problem_type: dependency-workaround-vs-version-bump
components: [type-checking, dependency-management]
technologies: [TypeScript, libsql, pnpm]
severity: medium
volatility: case-specific
---

# Check the next patch before working around a dependency type error

## Rule

When a TypeScript error appears immediately after a dependency upgrade, the first move is to check whether the next patch version of that dependency already fixes it. Designing a workaround — especially one that swaps a runtime entrypoint — without that check is how a five-second changelog miss turns into hours of hidden runtime regression.

## Context (the instance this came from)

`@libsql/client@0.17.2` shipped a packaging bug: its top-level `node.d.ts` re-exported only types from `@libsql/core/api` and dropped the local `createClient` declaration, so every consumer broke at typecheck:

```ts
import { createClient } from "@libsql/client";
//       ^^^^^^^^^^^^ TS2305: has no exported member 'createClient'
```

The `/http` subpath happened to declare `createClient` directly in its `.d.ts`, so swapping every import to `/http` made the typecheck error disappear:

```ts
import { createClient } from "@libsql/client/http"; // typecheck passes
```

Both entrypoints share the same exported function signature, so TypeScript accepts the swap. They are *not* the same at runtime: `/http` is HTTP-only and only accepts `https:` and `libsql:` URLs. Every test using `:memory:` or `file:...` URLs immediately threw `URL_SCHEME_NOT_SUPPORTED`. 53 tests broke.

`@libsql/client@0.17.3` (2026-04-23) restored the missing `createClient` declaration in `node.d.ts`. The fix was on npm for **a week** before the workaround was committed. Bumping the version and reverting all the `/http` imports resolved both the original typecheck error and the runtime regression in one move.

## Root cause

The dependency had a real bug. The mistake was treating it as a code problem to be coded around rather than as a version problem to be patched. The workaround had two properties that hid the regression:

1. **It changed runtime behavior under the cover of a type-only diff.** Both entrypoints satisfied the imported type, so nothing about the change *looked* runtime-relevant.
2. **It shipped past a failing local gate.** This repo's `quality-gate.sh` PostToolUse hook runs `vitest --changed` after each edit. The 53 broken tests *were* in the import graph of the modified files and *would* have surfaced — they likely did, and were either accepted as pre-existing or the gate's complaint was ignored to land the typecheck fix.

Neither of those is a tooling deficiency. The gate worked. The dep had a known fix on npm. The decision sequence skipped the changelog step.

## Prevention

**The five-second check.** When a typecheck error appears right after `pnpm update` (or right after the upgraded version of a dep is in your `node_modules`), before you touch any source file:

```bash
# What's the latest available?
pnpm view <package> version

# What changed between yours and latest?
pnpm view <package> versions --json | tail
# or read the package's CHANGELOG directly
```

If the next patch mentions types, exports, `.d.ts`, or the specific symbol you're missing, bump to it.

**Distinguish version bugs from code errors.** New TS error after `pnpm update`, no source change → suspect the upgrade, check the changelog. New TS error after editing your own code → fix your code, do not swap imports to dodge it.

**Treat entrypoint swaps as runtime-affecting changes.** Swapping `pkg` for `pkg/http`, `pkg/web`, `pkg/edge`, `pkg/sqlite3`, etc. is not a refactor — it picks a different runtime implementation. If you must swap (rare), the diff should include a comment naming the runtime constraint and the reason the default doesn't work.

**Trust the local gate.** If the PostToolUse `quality-gate.sh` reports test failures after your edit, those failures are about *your* edit until proven otherwise. "Pre-existing" is a hypothesis that requires checking the test on the parent commit before being accepted.

## Defect classification

- **Root cause**: specification error in `@libsql/client@0.17.2` (`createClient` declaration missing from `node.d.ts`).
- **Real fix**: upgrade to `0.17.3`. Released a week before the workaround.
- **Workaround that landed first**: every `@libsql/client` import switched to `@libsql/client/http`, which is HTTP-only at runtime and broke 53 tests using local URLs.
- **How it escaped review**: typecheck went green; the runtime test failures were either committed past or attributed to pre-existing flake.

## Rule scope

**Applies when:**
- A TS error appears after a dependency upgrade and the proposed fix is to change the import target rather than upgrade further.
- The candidate replacement entrypoint is a sibling subpath of the same package (`pkg` → `pkg/http`, `pkg/sqlite3`, `pkg/web`, etc.).
- The package's tests run real I/O (DB, HTTP, filesystem) — i.e., entrypoint differences will show up at runtime, not just at types.

**Does not apply when:**
- The dependency is at its latest version and the changelog confirms no fix is coming. Then the workaround is justified — but document the runtime constraint explicitly.
- You're swapping between two truly equivalent implementations (e.g., a polyfill and a native version with identical I/O contracts). The risk is lower, but the changelog check still costs nothing.

## Related

- PR: https://github.com/chrislacey89/civic-mirror/pull/63 — reverted the `/http` workaround across 9 files and bumped `@libsql/client` to `0.17.3`.
- Slice issue: #56 (Drama Watch foundations) — the slice that absorbed the revert as a documented scope expansion.
- Prior workaround commit: `6342f4a` — the typecheck-fix that introduced the entrypoint swap.
- npm release timeline: `@libsql/client@0.17.2` (2026-03-19, broken), `0.17.3` (2026-04-23, fixed).

## Shelf life

**Case-specific anchor, evergreen rule.** The libsql packaging bug itself can't recur — once this repo is past `0.17.3` the failure mode is closed. The general rule (changelog-check before workaround on dep-upgrade-induced TS errors) keeps applying for any dependency that ships a broken release. Revisit if the project moves off libsql or pins dependencies aggressively enough that upgrades are batched and intentional.

## Quick takeaway

After a dependency upgrade triggers a TypeScript error, read the changelog of the next patch version *before* you change any import. The fix is often already on npm.
