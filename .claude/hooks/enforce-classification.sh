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
  # Check for classification markers
  if [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.tdd-active" ] && [ ! -f "$CLAUDE_PROJECT_DIR/.claude/.tdd-skipped" ]; then
    echo '{"decision":"block","reason":"BLOCKED: classify work in /execute Step 3 before writing implementation files. Either invoke /tdd (backend/behavior-heavy) or create .claude/.tdd-skipped (visual frontend)."}' >&2
    exit 2
  fi
fi
exit 0
