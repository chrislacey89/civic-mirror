---
date: 2026-05-01
category: testing-patterns
problem_type: test-detection-blind-spot
components: [test-runner, import-resolution, type-checking]
technologies: [TypeScript, Vitest, libsql, Node.js]
severity: high
volatility: stable
---

# TypeScript-Only Fixes Can Hide Runtime Regressions When Imports Change

## Problem

A TypeScript fix that resolves a type error by switching to a different import entrypoint can pass type checking while silently breaking tests. The runtime behavior changes (different code path, different implementation), but the test runner's `--changed` gate doesn't detect it as a change, so affected tests don't run unless something else modifies a test file or dependency.

## Context

During a refactor, an import was changed from one entrypoint to another (e.g., from a local implementation to an HTTP-only stub) to resolve a TypeScript error. The type error disappeared, signaling success at the type-checking level. However, the runtime behavior of the imported module was completely different—53 tests that depended on that module began failing silently.

The tests didn't run during the `--changed` gate because:
1. The `.test.ts` files themselves weren't modified
2. Vitest's `--changed` heuristic looks at file modifications, not import resolution changes
3. The test discovery and execution logic saw no reason to re-run these tests

The regression remained invisible until a later change happened to touch something in the import graph, triggering the affected tests to run.

## Symptoms

- TypeScript errors resolve after switching an import, but no behavioral verification happens
- Tests pass in CI after a type-checking-only fix
- Regressions appear later when an unrelated change happens to trigger test re-runs
- The affected tests all involve the changed import, but that connection is not obvious from the `--changed` output
- No error or warning signals the mismatch between type-level and runtime-level changes

## Root Cause

**Primary cause:** TypeScript validation and test runner change detection operate on different signals.

- **TypeScript** checks: "Does the type match the declared interface?" This can pass even if the implementation is completely different (e.g., an HTTP stub vs. a local implementation).
- **Vitest's `--changed` gate** checks: "Did any `.test.ts` files change? Did dependencies listed in `package.json` change?" It does not check: "Did the runtime entrypoint for an import change?"

**Why this is structural:** The import resolution system (which module actually loads at runtime) is decoupled from the test runner's change detection. A file at `path/to/module.ts` can be replaced with `path/to/module/http.ts` without touching the test files that import from `module`—so the test runner has no signal that re-runs are needed.

**Delayed feedback:** The regression surfaced only when something else modified a file in the import graph, triggering a full re-run. This delay masked the true cause: the import change, not the later edit.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** The change detection gap creates a delayed-feedback loop. Type-checking succeeds immediately (good feedback), but test failures remain hidden until another change triggers a full test run (bad feedback, late arrival).

## Rule Scope

**Applies when:**
- You resolve a TypeScript error by changing which module/entrypoint is imported (not adding a new import, but *replacing* the source)
- The new import has the same type signature but different runtime behavior (e.g., HTTP stub, mock, alternative implementation)
- Tests depend on the specific runtime behavior of the old import
- The test runner uses a `--changed` gate that only tracks file modifications and explicit dependency versions, not import resolution

**Inverts or does not apply when:**
- You swap between two implementations that are semantically equivalent at runtime (e.g., different implementations of the same algorithm, both with identical I/O)—in this case, the regression is a genuine bug, not a hidden one, and should still be caught by tests
- The test runner has been configured to invalidate its change cache when import resolution changes (e.g., via a custom `vitest.config.ts` watcher rule)
- You're fixing a type error in the import statement itself, not the imported module (e.g., `import type Foo` → `import Foo`)—this is safer because the types align

**Sibling docs:**
- See `devops/type-checking-without-runtime-verification.md` if it exists (covers the broader pattern of letting type checking substitute for runtime validation)
- See `testing-patterns/vitest---changed-gate-limitations.md` for edge cases in how Vitest detects changes

## Solution

**Before:**
```typescript
// ❌ This resolves the TypeScript error, but runtime behavior changes
// libsql was failing at runtime; switching to HTTP stub
import { sql } from "@libsql/client";  // Real implementation, complex setup
```

**After (temporarily fixes type errors, but hides regressions):**
```typescript
// ❌ Type error gone, but runtime now uses HTTP-only stub
// This passes type checking but breaks 53 tests silently
import { sql } from "@libsql/client/http";  // HTTP-only, different behavior
```

**Correct approach:**
```typescript
// ✓ Resolve the root cause, not the symptom
// Fix the underlying issue (setup, version, API usage) instead of swapping entrypoints

// Option 1: Fix the actual issue with the real import
import { sql } from "@libsql/client";
// Then: update setup, fix API call, or adjust test mocks

// Option 2: If a stub is intentional, be explicit about the behavioral change
import { sql } from "@libsql/client/http";  // Deliberate: HTTP-only for this build variant
// Then: manually run affected tests to verify, or refactor tests to handle both paths
```

## Prevention

**Code-level:**

1. **After any import entrypoint change, manually run the full test suite:**
   ```bash
   npm test  # or vitest (not vitest --changed)
   ```
   Don't rely on `--changed` after import changes. Make this a pre-commit hook if the import change was intentional.

2. **Add a linter rule to flag import-entrypoint swaps:**
   ```typescript
   // Example: ESLint rule that warns when an import changes to a known-alternative path
   // e.g., "@libsql/client" → "@libsql/client/http"
   // This doesn't prevent it, but surfaces the intent for review
   ```

3. **Document the behavioral difference in a comment:**
   ```typescript
   // CHANGED ENTRYPOINT: switched from @libsql/client (real impl) to /http (stub)
   // Tests may have changed behavior expectations. Run full suite after this change.
   import { sql } from "@libsql/client/http";
   ```

**Process-level:**

1. **Amend the merge checklist:** Before approving a PR that changes an import entrypoint (especially for third-party modules), require evidence that affected tests were run in full, not just `--changed`. Add to `/pre-merge` review steps: "If imports changed, run full test suite."

2. **Reconfigure vitest to catch import resolution changes:**
   ```typescript
   // vitest.config.ts
   export default defineConfig({
     test: {
       // Invalidate change cache if import metadata changes
       // (requires custom watcher setup—consult vitest docs for your version)
     },
   });
   ```

3. **Strengthen the type-checking → runtime-verification pipeline:** When TypeScript errors resolve, add a verification step: "What did this change affect at runtime?" This is part of `/pre-merge` code review, not automated. The agent should ask: "Did this type fix also change what code runs?"

## Planning / Calibration Notes

- **What widened the work:** The hidden regression delayed discovery until a later, unrelated change forced a full test run. This added rework and debuggng time later.
- **What tightened the work:** A full test run immediately after the import change would have caught it instantly.
- **Future planning adjustment:** When shaping work that involves import changes, library migrations, or switching between implementation variants, include a line item: "Verify runtime behavior with full test suite; do not rely on `--changed` gate." This is a 5-minute verification step that prevents silent regressions.

## Defect Classification

**Origin phase:** Design error (the type fix prioritized type-checking success over runtime validation)
**Fix type:** Workaround (switching entrypoints suppressed the type error but didn't fix the root cause). The real fix required addressing the root cause (setup, API, or environment).

## Key Decision

**Decision:** When a TypeScript error appears, distinguish between type-level fixes (safe) and runtime-entrypoint swaps (risky).

**Rationale:** Type-level fixes are self-contained. Entrypoint swaps change behavior invisibly if the types align.

**Alternatives considered:**
1. Ignore the TypeScript error and use `@ts-ignore` — defers the fix, doesn't address root cause
2. Fix the root cause properly — slower upfront, but catches regressions immediately
3. Swap entrypoints + manually verify tests — works, but requires discipline and is easy to miss

**Revisable:** Yes. If Vitest or your test runner adds smarter change detection (e.g., tracking import resolution), this rule becomes less critical.

## Related

- GitHub issue/PR: (if applicable, link to the libsql refactor)
- Related docs/solutions: (add references if similar integration issues exist)

## Shelf Life

**Evergreen** — This pattern will recur whenever:
- TypeScript errors are resolved by import swaps
- Test runners use file-based change detection
- Runtime behavior differs between imports with the same type signature

Becomes less critical if:
- Vitest or the test runner adds import-resolution-aware change detection
- You refactor away from libsql or the specific integration that surfaced this
- Stronger verification practices (mandatory full-suite runs) become process standard

---

## Quick Takeaway

**Never trust that a TypeScript error fix didn't break runtime behavior.** After any import entrypoint change—even if types align—run the full test suite, not just `--changed`. The 5-minute full run prevents silent regressions that stay hidden until the next unrelated change.
