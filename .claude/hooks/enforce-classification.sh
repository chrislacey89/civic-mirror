#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only enforce for TypeScript files (not test files, not type declarations, not config)
if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx ]]; then
  # Skip test files and type declarations
  if [[ "$FILE_PATH" == *test* || "$FILE_PATH" == *spec* || "$FILE_PATH" == *.d.ts ]]; then
    exit 0
  fi
  # Skip config files (drizzle.config, vite.config, etc.)
  if [[ "$FILE_PATH" == *.config.* ]]; then
    exit 0
  fi
  # Check for classification markers — but stand down on a stamped branch, so the
  # post-review clause below is the one that decides there. /execute Step 6 removes
  # BOTH classification markers before it hands off to /pre-merge, so by the time
  # .review-stamped exists there is never a marker left for this test to find.
  if [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.review-stamped" ] && [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.tdd-active" ] && [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.tdd-skipped" ]; then
    echo '{"decision":"block","reason":"BLOCKED: classify work in /execute Step 3 before writing implementation files. Either invoke /tdd (backend/behavior-heavy) or create .claude/.tdd-skipped (visual frontend)."}' >&2
    exit 2
  fi
  # Post-review edit lock. /pre-merge Phase 4 touches .review-stamped beside the
  # review-currency stamp; /fix-findings touches .fix-findings-active when it
  # loads and removes it when it reports. Between those two, an implementation
  # edit is a post-review fix authored by the session the review just went around.
  if [ -f "$CLAUDE_PROJECT_DIR/.claude/.review-stamped" ] && [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.fix-findings-active" ]; then
    echo '{"decision":"block","reason":"BLOCKED: this branch has been reviewed and stamped. A post-review fix needs an independent author. Either invoke /fix-findings <numbers>, or delete .claude/.review-stamped to take the edit yourself."}' >&2
    exit 2
  fi
fi
exit 0
