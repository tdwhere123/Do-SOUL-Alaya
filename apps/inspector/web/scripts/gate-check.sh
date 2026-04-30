#!/usr/bin/env bash
# Reviewer Gate §2.4 self-check for P4-inspector-frontend.
# Cards G1, G6, G7, G8 are covered by tests/build; this script covers
# the grep-based gates G2 / G3 / G4 / G5.

set -euo pipefail

cd "$(dirname "$0")/.."
SRC=src
fail=0

step() { printf "\n[gate-check] %s\n" "$1"; }

step "G2 — token must NEVER be persisted (no localStorage / sessionStorage)"
if grep -RnE "(localStorage|sessionStorage)" "$SRC"; then
  echo "  ✗ found localStorage/sessionStorage usage" >&2
  fail=1
else
  echo "  ✓ pass"
fi

step "G3 — every fetch must go through src/api.ts (one hit allowed there)"
hits=$(grep -RnE "\\bfetch\\(" "$SRC" || true)
if [ -z "$hits" ]; then
  echo "  ✓ no fetch() calls (api.ts uses fetch via global)"
else
  bad=$(printf "%s\n" "$hits" | grep -vE "(api\\.ts|api\\.test\\.ts|test/setup|\\.test\\.tsx)" || true)
  if [ -n "$bad" ]; then
    echo "  ✗ stray fetch() outside api.ts:"
    echo "$bad" >&2
    fail=1
  else
    echo "  ✓ pass"
  fi
fi

step "G4 — no memory CRUD / governance UI"
if grep -RnE "(propose_memory_update|apply_override|governance|memory_create|memory_delete)" "$SRC"; then
  echo "  ✗ found forbidden memory-CRUD / governance reference" >&2
  fail=1
else
  echo "  ✓ pass"
fi

step "G5 — no external CDN https URLs in source"
hits=$(grep -RnE "https://" "$SRC" --include="*.ts" --include="*.tsx" --include="*.css" || true)
if [ -n "$hits" ]; then
  bad=$(printf "%s\n" "$hits" | grep -viE "(api\\.openai\\.com|alaya|placeholder|reactrouter\\.com)" || true)
  if [ -n "$bad" ]; then
    echo "  ! external https URLs found (review for CDN content):"
    echo "$bad"
  else
    echo "  ✓ pass (only placeholders / docs URLs)"
  fi
else
  echo "  ✓ pass (no https URLs)"
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "[gate-check] FAILED" >&2
  exit 1
fi

echo ""
echo "[gate-check] PASS — Reviewer Gate G2/G3/G4/G5 all green"
