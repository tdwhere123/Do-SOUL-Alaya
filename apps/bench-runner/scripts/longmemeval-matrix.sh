#!/usr/bin/env bash
# Unified LongMemEval A/B qualification entry. Shares longmemeval-matrix-cell.sh.
# Required: MATRIX_RUN_ROOT.
# Optional: MATRIX_CELLS (default "A B"), MATRIX_AUTHORIZE=1 to run authorizer,
#           MATRIX_CONTRACT (default $MATRIX_RUN_ROOT/matrix-promotion-contract.json),
#           MATRIX_EXPERIMENT=1 for a local A/B pair without promotion evidence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUN_ROOT="${MATRIX_RUN_ROOT:?MATRIX_RUN_ROOT is required}"
CELLS="${MATRIX_CELLS:-A B}"
CONTRACT="${MATRIX_CONTRACT:-$RUN_ROOT/matrix-promotion-contract.json}"
AUTHORIZATION="${MATRIX_AUTHORIZATION:-$RUN_ROOT/matrix-promotion-authorization.json}"
EXPERIMENT="${MATRIX_EXPERIMENT:-0}"

if [[ "$EXPERIMENT" == "1" ]]; then
  [[ "$CELLS" == "A B" ]] || {
    echo "local experiment requires the exact A B cell pair" >&2; exit 64;
  }
  [[ "${MATRIX_AUTHORIZE:-0}" != "1" ]] || {
    echo "local experiment cannot authorize promotion" >&2; exit 64;
  }
fi

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
  evidence_name="cell-$(printf '%s' "$cell" | tr 'AB' 'ab')"
  if [[ -f "$RUN_ROOT/evidence/$evidence_name/kpi.json" ]]; then
    echo "cell $cell kpi: $RUN_ROOT/evidence/$evidence_name/kpi.json" >&2
  fi
done

if [[ "$EXPERIMENT" == "1" ]]; then
  rtk node "$SCRIPT_DIR/longmemeval-experiment-identity.mjs" pair \
    "$RUN_ROOT/A.runner-identity.json" \
    "$RUN_ROOT/B.runner-identity.json" \
    "$RUN_ROOT/experiment-pair-identity.json"
  echo "experiment identity: $RUN_ROOT/experiment-pair-identity.json" >&2
fi

if [[ "${MATRIX_AUTHORIZE:-0}" == "1" ]]; then
  [[ -f "$CONTRACT" ]] || { echo "missing contract: $CONTRACT" >&2; exit 65; }
  cd "$WORKTREE"
  rtk node apps/bench-runner/bin/alaya-bench-runner.mjs \
    authorize-longmemeval-matrix \
    --contract "$CONTRACT" \
    --out "$AUTHORIZATION" \
    2>&1 | tee "$RUN_ROOT/matrix-authorizer.log"
fi
