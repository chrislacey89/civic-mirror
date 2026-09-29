#!/usr/bin/env bash
# Tracer (slice 1, #92): the pipeline CLI boots, parses flags, and loads the
# full production layer graph under Effect v4 — offline, no credentials.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results
OUT=test-results/slice-1.transcript.txt
: > "$OUT"
fail=0
run() {
  echo "\$ pnpm -s pipeline $*" | tee -a "$OUT"
  timeout 90 pnpm -s pipeline "$@" 2>&1 | grep -v 'injected env' | tee -a "$OUT"
  echo | tee -a "$OUT"
}
expect() { grep -qF -- "$1" "$OUT" || { echo "TRACER FAIL: missing \"$1\"" | tee -a "$OUT"; fail=1; }; }

echo "# effect $(node -p "require('effect/package.json').version")" | tee -a "$OUT"
run list-bodies
expect "ellettsville-town-council"
expect "rbb-school-board"
run run --body nope
expect "No body matched the provided --body slug"
run --help
expect "list-bodies"
expect "drama:detect"
expect "# effect 4."
exit $fail
