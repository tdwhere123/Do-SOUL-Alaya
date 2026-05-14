#!/usr/bin/env bash
# @anchor full-public-bench-runner — sharded LongMemEval-S full set
#
# Fans the LongMemEval full-set retrieval evaluation across N independent
# Node processes (each owns its own in-process daemon + temp SQLite DB),
# then merges the shard KPIs into a single bench-history entry. Intra-
# process concurrency does NOT work because startBenchDaemon mutates
# process.env — see apps/bench-runner/src/longmemeval/runner.ts
# @longmemeval-sequential anchor.
#
# Usage:
#   apps/bench-runner/scripts/run-full-public-bench.sh \
#     [--variant s|oracle] [--shards N] [--limit M]
#
# Defaults: variant=s, shards=4, no limit (full 500).
set -euo pipefail

VARIANT="s"
SHARDS="4"
LIMIT=""
LOG_DIR="${BENCH_LOG_DIR:-/tmp/alaya-bench-logs}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant) VARIANT="$2"; shift 2;;
    --shards) SHARDS="$2"; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

mkdir -p "$LOG_DIR"
TS="$(date -u '+%Y-%m-%dT%H%M%SZ')"
RUN_TAG="longmemeval_${VARIANT}_s${SHARDS}_${TS}"
MASTER_LOG="$LOG_DIR/${RUN_TAG}.log"

# Resolve total sample size by reading the pinned meta (avoid loading the
# full dataset JSON in the driver). Dataset variants are pinned under
# docs/v0.3/bench-history/datasets/<variant>.meta.json.
case "$VARIANT" in
  oracle) META="docs/v0.3/bench-history/datasets/longmemeval_oracle.meta.json";;
  s) META="docs/v0.3/bench-history/datasets/longmemeval_s.meta.json";;
  m) META="docs/v0.3/bench-history/datasets/longmemeval_m.meta.json";;
  *) echo "unknown variant: $VARIANT" >&2; exit 2;;
esac
TOTAL=$(node -e "const d=JSON.parse(require('fs').readFileSync('$META','utf8'));console.log(d.question_count);")
EFFECTIVE_TOTAL="${LIMIT:-$TOTAL}"

# Shard size: ceil(effective_total / SHARDS)
SHARD_SIZE=$(( (EFFECTIVE_TOTAL + SHARDS - 1) / SHARDS ))

echo "[$(date -u -Iseconds)] driver=$RUN_TAG variant=$VARIANT shards=$SHARDS total=$EFFECTIVE_TOTAL shard_size=$SHARD_SIZE" | tee "$MASTER_LOG"

SHARD_PIDS=()
SHARD_ROOTS=()
START=$(date +%s)

for ((i=0; i<SHARDS; i++)); do
  OFFSET=$((i * SHARD_SIZE))
  if (( OFFSET >= EFFECTIVE_TOTAL )); then break; fi
  REMAIN=$((EFFECTIVE_TOTAL - OFFSET))
  SLICE=$(( REMAIN < SHARD_SIZE ? REMAIN : SHARD_SIZE ))
  SHARD_ROOT="/tmp/alaya-bench-shards/${RUN_TAG}/shard-${i}"
  SHARD_LOG="$LOG_DIR/${RUN_TAG}_shard${i}.log"
  mkdir -p "$SHARD_ROOT"
  SHARD_ROOTS+=("$SHARD_ROOT")
  echo "[$(date -u -Iseconds)] launching shard $i offset=$OFFSET limit=$SLICE root=$SHARD_ROOT log=$SHARD_LOG" | tee -a "$MASTER_LOG"
  (
    node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval \
      --variant "$VARIANT" \
      --offset "$OFFSET" \
      --limit "$SLICE" \
      --history-root "$SHARD_ROOT" \
      >"$SHARD_LOG" 2>&1
  ) &
  SHARD_PIDS+=("$!")
done

echo "[$(date -u -Iseconds)] waiting for ${#SHARD_PIDS[@]} shard(s)..." | tee -a "$MASTER_LOG"
EXIT_FAIL=0
for pid in "${SHARD_PIDS[@]}"; do
  if ! wait "$pid"; then
    echo "[$(date -u -Iseconds)] shard pid=$pid exited non-zero" | tee -a "$MASTER_LOG"
    EXIT_FAIL=1
  fi
done

END=$(date +%s)
ELAPSED=$((END - START))
echo "[$(date -u -Iseconds)] all shards complete elapsed=${ELAPSED}s exit_fail=$EXIT_FAIL" | tee -a "$MASTER_LOG"

if (( EXIT_FAIL != 0 )); then
  echo "one or more shards failed — skipping merge" | tee -a "$MASTER_LOG"
  exit 1
fi

echo "[$(date -u -Iseconds)] merging shards..." | tee -a "$MASTER_LOG"
node apps/bench-runner/bin/alaya-bench-runner.mjs merge-longmemeval \
  --variant "$VARIANT" \
  --shards "${SHARD_ROOTS[@]}" \
  --history-root "docs/v0.3/bench-history" \
  2>&1 | tee -a "$MASTER_LOG"

echo "[$(date -u -Iseconds)] driver done. master log=$MASTER_LOG" | tee -a "$MASTER_LOG"
