#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

LIMIT="${BENCH_DAILY_LIMIT:-100}"
HISTORY_ROOT="${BENCH_DAILY_HISTORY_ROOT:-docs/bench-history}"
THRESHOLD_PP="${BENCH_DAILY_DEGRADATION_THRESHOLD_PP:-5}"
LOG_DIR="${BENCH_LOG_DIR:-/tmp/alaya-bench-logs}"
mkdir -p "$LOG_DIR"

declare -a EMBEDDINGS=("disabled" "env")
declare -a POLICY_SHAPES=("stress" "chat")

if [[ -n "${BENCH_DAILY_EMBEDDINGS:-}" ]]; then
  read -r -a EMBEDDINGS <<<"$BENCH_DAILY_EMBEDDINGS"
fi

if [[ -n "${BENCH_DAILY_POLICY_SHAPES:-}" ]]; then
  read -r -a POLICY_SHAPES <<<"$BENCH_DAILY_POLICY_SHAPES"
fi

run_one() {
  local embedding="$1"
  local policy_shape="$2"
  local ts
  ts="$(date -u '+%Y-%m-%dT%H%M%SZ')"
  local log="$LOG_DIR/daily_longmemeval_s_${embedding}_${policy_shape}_${ts}.log"

  echo "[$(date -u -Iseconds)] daily bench embedding=$embedding policy_shape=$policy_shape limit=$LIMIT" | tee "$log"
  if ! node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval \
    --variant s \
    --limit "$LIMIT" \
    --embedding "$embedding" \
    --policy-shape "$policy_shape" \
    --simulate-report mixed \
    --history-root "$HISTORY_ROOT" \
    2>&1 | tee -a "$log"; then
    echo "[$(date -u -Iseconds)] daily bench failed embedding=$embedding policy_shape=$policy_shape" | tee -a "$log"
    return 1
  fi

  node scripts/append-bench-degradation-backlog.mjs \
    --history-root "$HISTORY_ROOT" \
    --bench public \
    --threshold-pp "$THRESHOLD_PP" \
    2>&1 | tee -a "$log"
}

for embedding in "${EMBEDDINGS[@]}"; do
  case "$embedding" in
    disabled|env) ;;
    *) echo "unknown embedding mode: $embedding" >&2; exit 2;;
  esac
  for policy_shape in "${POLICY_SHAPES[@]}"; do
    case "$policy_shape" in
      stress|chat) ;;
      *) echo "unknown policy shape: $policy_shape" >&2; exit 2;;
    esac
    run_one "$embedding" "$policy_shape"
  done
done
