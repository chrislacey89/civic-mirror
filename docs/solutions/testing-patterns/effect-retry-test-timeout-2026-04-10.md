---
date: 2026-04-10
category: testing-patterns
problem_type: real-time primitive in test environment
components: [pipeline, orchestrator]
technologies: [effect, vitest, schedule, retry]
severity: medium
volatility: stable
---

# Effect.retry with production Schedule values breaks vitest timeouts

## Problem

Adding `Effect.retry(Schedule.exponential(...).pipe(Schedule.compose(Schedule.recurs(n))))` with production-sized values causes existing tests to hit vitest's 5-second timeout. Tests that previously passed in milliseconds suddenly take 3–7 seconds because the retry schedule actually *waits* between attempts, using real wall-clock time.

## Context

While implementing issue #8's retry requirements, I added two schedules to the orchestrator:

```typescript
const DEFAULT_NETWORK_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500 };
const DEFAULT_LLM_RETRY: RetryPolicy = { attempts: 2, baseDelayMs: 1000 };
```

and wrapped the service calls:

```typescript
const summary = yield* summarizer.summarize({...}).pipe(Effect.retry(config.llmSchedule));
```

The orchestrator tests passed before the retry wrapping. After the wrapping, the test **"catches a per-listing error, sends an alert, and continues with the next listing"** timed out at 5004ms. The test deliberately triggers a `LlmError` to verify alert-and-recover behavior — and the retry schedule dutifully waited 1s, then 2s, then failed, per listing, per test. Two listings × 3 seconds of backoff per listing = past the 5s default.

## Symptoms

- One specific test times out at exactly 5000–5010ms after adding Effect.retry
- Other tests still pass because they don't trigger the retry path
- Increasing `testTimeout` makes the test pass but is a workaround, not a fix
- `pnpm test` wall-clock time jumps by several seconds because the retries run in real time
- The test is verifying error-recovery behavior (the exact path the retries wrap), so the retries *will* fire

## Root Cause

`Effect.retry` with `Schedule.exponential` uses real wall-clock time. There's no implicit "fast-forward" in Effect tests the way there is with `jest.useFakeTimers()` or `vi.useFakeTimers()` — you'd have to opt into `TestClock` explicitly, and even then it requires wrapping the test in an `Effect.provide(TestContext.TestContext)` block.

Production Schedule values are *bad* test defaults. A 3-attempt exponential-500ms schedule costs 0.5 + 1 + 2 = 3.5s of wall-clock time for a single always-failing operation. A 2-attempt exponential-1s schedule costs 1 + 2 = 3s. The test suite hitting the error path twice already blows the default vitest timeout.

The deeper lesson: any Effect primitive that touches real time (`Effect.sleep`, `Effect.delay`, `Schedule.spaced`, `Schedule.exponential`, `Schedule.fixed`) is a hidden coupling to wall-clock time. If a test can reach that code, the test either needs `TestClock` or needs to pass a no-op version of the primitive.

## Learning Level

- **Level:** Pattern
- **Feedback loop or delay:** Immediate — the test fails on the first run after the change, which is fast enough that the fix happens in the same session. But the pattern recurs: any *future* Effect primitive that reaches into real time (debounce, throttle, timeout, interval) will reproduce the same failure mode unless we make injection the default from the start.

## Solution

Make retry policies injectable via the pipeline input, defaulting to production values, and have tests pass `attempts: 0` to disable retries entirely.

**Before:**

```typescript
// Module-level constant — can't be overridden by tests
const networkRetry = Schedule.exponential(Duration.millis(500)).pipe(
	Schedule.compose(Schedule.recurs(3)),
);

// Hardcoded in the orchestrator
yield* scraper.scrapeListings(...).pipe(Effect.retry(networkRetry));
```

**After:**

```typescript
type RetryPolicy = {
	attempts: number;
	baseDelayMs: number;
};

const DEFAULT_NETWORK_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500 };
const DEFAULT_LLM_RETRY: RetryPolicy = { attempts: 2, baseDelayMs: 1000 };

function scheduleFromPolicy(policy: RetryPolicy) {
	return Schedule.exponential(Duration.millis(policy.baseDelayMs)).pipe(
		Schedule.compose(Schedule.recurs(policy.attempts)),
	);
}

type RunPipelineInput = {
	// ... other fields
	networkRetry?: RetryPolicy;
	llmRetry?: RetryPolicy;
};

// In runPipeline, resolve once:
const config: ResolvedConfig = {
	...input,
	networkSchedule: scheduleFromPolicy(input.networkRetry ?? DEFAULT_NETWORK_RETRY),
	llmSchedule: scheduleFromPolicy(input.llmRetry ?? DEFAULT_LLM_RETRY),
};

// Use at call site:
yield* scraper.scrapeListings(...).pipe(Effect.retry(config.networkSchedule));
```

Tests pass `{ attempts: 0, baseDelayMs: 0 }` for both policies. `Schedule.recurs(0)` executes once with no retry, so the retry schedule is effectively a no-op and tests complete in milliseconds again.

## Prevention

**Code-level:**

- Treat every `Effect.sleep` / `Effect.delay` / `Schedule.*` reference as a test-visible timing coupling. If the code is reachable by a test, the primitive must be injectable via config, not hardcoded.
- A `grep -n 'Effect\.sleep\|Effect\.delay\|Schedule\.' src/` audit is worth running before any "this test is slow" investigation — it catches all the timing couplings at once.
- Consider `TestClock` for more complex cases, but injection is simpler, faster to set up, and doesn't require wrapping every test in `Effect.provide(TestContext.TestContext)`.

**Process-level:**

- `/tdd` and `/execute` should both flag this failure mode explicitly: "test timeout jumped from <500ms to >3000ms" is a signal that a real-time Effect primitive was introduced and not made injectable. The right fix is never "bump testTimeout" unless you have a specific reason.
- When `/research` specifies retry behavior for a slice, the shaping should note "retry policy must be injectable" as an explicit constraint, so the first implementation commit gets it right instead of patching it post-hoc.

## Planning / Calibration Notes

- **What widened the work:** discovering the timeout required retrying, diagnosing, and refactoring the schedules into injectable config. ~20 minutes of unplanned work.
- **What tightened the work:** the fix generalized to YouTube rate limiting (`youtubeDelayMs`) in the same commit, so the pattern "all timing is injectable" was established once and reused.
- **Future planning adjustment:** when `/write-a-prd` identifies a rabbit hole involving retry, backoff, rate limiting, or timeout, the PRD should specify "inject the policy via config" as part of the resolution, not leave it to implementation.

## Actuals Worth Reusing

- **Comparable future work:** any Effect service that wraps a flaky external call (LLM, HTTP, DB with intermittent failures)
- **Reusable baseline:** budget ~30 min on top of the retry implementation to make the policy injectable and update tests. Always cheaper than discovering it mid-test-run.

## Related

- PR #23 — https://github.com/chrislacey89/civic-mirror/pull/23 (commit `45edc41 add retry policies and YouTube rate limiting to orchestrator`)
- Effect docs: [Schedule](https://effect.website/docs/scheduling/introduction/), [TestClock](https://effect.website/docs/testing/test-clock/)

## Shelf Life

Stable — applies as long as the project uses Effect.retry / Schedule primitives and vitest with default timeouts. Revisit if the project adopts `TestClock` as a default testing pattern (would change the fix from "injection" to "virtual time"), or if Effect ships built-in test-mode schedules.
