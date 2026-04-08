#!/bin/bash
set -e

claude --message "Look at the open GitHub issues in chrislacey89/civic-mirror. Pick the highest-risk unblocked issue that still needs implementation, respecting any blocking relationships or dependency labels.

Use /execute to implement exactly one reviewable slice.

After implementation, run these feedback loops:
- pnpm check (biome format + lint)
- pnpm test (vitest)
- pnpm build (vite)

Quality expectations:
- Implement one reviewable slice only — do not silently expand scope.
- Prefer risky slices early when multiple are unblocked.
- If a feedback loop fails, fix it before moving on.
- If blocked after repeated failure, leave the exact error output as a comment on the GitHub issue and stop — do not retry forever.
- This is production code for a local government transparency platform. Treat it accordingly.

If all issue work is complete, say DONE and stop."
