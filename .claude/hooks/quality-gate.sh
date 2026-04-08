#!/bin/bash
# Quality gate — runs after each Write/Edit to catch issues early.
# Only runs on TypeScript/JavaScript files. Skips test/config files.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only gate TypeScript/JavaScript implementation files
if [[ ! "$FILE_PATH" == *.ts && ! "$FILE_PATH" == *.tsx && ! "$FILE_PATH" == *.js && ! "$FILE_PATH" == *.jsx ]]; then
  exit 0
fi
# Skip test files, type declarations, config files
if [[ "$FILE_PATH" == *test* || "$FILE_PATH" == *spec* || "$FILE_PATH" == *.d.ts || "$FILE_PATH" == *.config.* ]]; then
  exit 0
fi

# 1. Biome check (fast — format + lint)
BIOME_OUTPUT=$(pnpm biome check src/ 2>&1)
BIOME_EXIT=$?

# 2. TypeScript type check
TSC_OUTPUT=$(pnpm tsc --noEmit 2>&1)
TSC_EXIT=$?

if [ $BIOME_EXIT -ne 0 ] || [ $TSC_EXIT -ne 0 ]; then
  if [ $BIOME_EXIT -ne 0 ]; then
    echo "Biome errors found:" >&2
    echo "$BIOME_OUTPUT" >&2
    echo "" >&2
  fi
  if [ $TSC_EXIT -ne 0 ]; then
    echo "TypeScript errors found:" >&2
    echo "$TSC_OUTPUT" >&2
  fi
  exit 2
fi

# 3. Run tests for changed files only (vitest import graph analysis)
VITEST_OUTPUT=$(pnpm vitest run --changed 2>&1)
VITEST_EXIT=$?

# Skip if no test files found (exit 1 + "No test files found")
if [ $VITEST_EXIT -ne 0 ]; then
  if echo "$VITEST_OUTPUT" | grep -q "No test files found"; then
    : # no tests yet, not a failure
  else
    echo "Tests failed for changed files:" >&2
    echo "$VITEST_OUTPUT" >&2
    exit 2
  fi
fi

exit 0
