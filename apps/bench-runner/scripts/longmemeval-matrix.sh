#!/usr/bin/env bash
# Unified LongMemEval A/B/C/D matrix entry (no B2). Shares longmemeval-matrix-cell.sh.
# Required: MATRIX_RUN_ROOT.
# Optional: MATRIX_CELLS (default "A B C D"), MATRIX_AUTHORIZE=1 to run authorizer,
#           MATRIX_CONTRACT (default $MATRIX_RUN_ROOT/matrix-promotion-contract.json).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUN_ROOT="${MATRIX_RUN_ROOT:?MATRIX_RUN_ROOT is required}"
CELLS="${MATRIX_CELLS:-A B C D}"
CONTRACT="${MATRIX_CONTRACT:-$RUN_ROOT/matrix-promotion-contract.json}"
AUTHORIZATION="${MATRIX_AUTHORIZATION:-$RUN_ROOT/matrix-promotion-authorization.json}"

mkdir -p "$RUN_ROOT"
for cell in $CELLS; do
  set +e
  MATRIX_RUN_ROOT="$RUN_ROOT" "$SCRIPT_DIR/longmemeval-matrix-cell.sh" "$cell" \
    2>&1 | tee "$RUN_ROOT/$cell.driver.log"
  status="${PIPESTATUS[0]}"
  set -e
  if (( status > 1 )); then
    echo "cell $cell failed before committing valid evidence" >&2
    exit "$status"
  fi
  evidence_name="cell-$(printf '%s' "$cell" | tr 'ABCD' 'abcd')"
  if [[ -f "$RUN_ROOT/evidence/$evidence_name/kpi.json" ]]; then
    echo "cell $cell kpi: $RUN_ROOT/evidence/$evidence_name/kpi.json" >&2
  fi
done

if [[ "${MATRIX_AUTHORIZE:-0}" == "1" ]]; then
  [[ -f "$CONTRACT" ]] || { echo "missing contract: $CONTRACT" >&2; exit 65; }
  cd "$WORKTREE"
  rtk node apps/bench-runner/bin/alaya-bench-runner.mjs \
    authorize-longmemeval-matrix \
    --contract "$CONTRACT" \
    --out "$AUTHORIZATION" \
    2>&1 | tee "$RUN_ROOT/matrix-authorizer.log"
fi
