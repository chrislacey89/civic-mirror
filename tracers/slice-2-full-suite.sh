#!/usr/bin/env bash
# Tracer (slice 2, #92): whole project type-checks against Effect v4, the full
# vitest suite matches the prod baseline (205/205), and the CLI still boots.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results
OUT=test-results/slice-2.transcript.txt
: > "$OUT"
fail=0

echo "# effect $(node -p "require('effect/package.json').version")" | tee -a "$OUT"
echo '$ npx tsc --noEmit -p .' | tee -a "$OUT"
npx tsc --noEmit -p . 2>&1 | tee -a "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] && echo "tsc: clean" | tee -a "$OUT" || { echo "TRACER FAIL: tsc" | tee -a "$OUT"; fail=1; }

echo '$ pnpm vitest run' | tee -a "$OUT"
# .repos/ holds the Effect reference clones used by the migration; keep them out.
pnpm vitest run --exclude '.repos/**' --exclude '**/node_modules/**' 2>&1 \
  | grep -E 'Test Files|Tests |FAIL' | tee -a "$OUT"
grep -qE 'Tests +205 passed \(205\)' "$OUT" || { echo "TRACER FAIL: vitest != 205/205" | tee -a "$OUT"; fail=1; }

./tracers/slice-1-cli-boots.sh >/dev/null 2>&1 && echo "cli tracer: pass" | tee -a "$OUT" || { echo "TRACER FAIL: cli" | tee -a "$OUT"; fail=1; }
exit $fail
