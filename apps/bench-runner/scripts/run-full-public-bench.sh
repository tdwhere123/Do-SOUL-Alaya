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
# Defaults: variant=s, shards=2 (memory-guarded; see @anchor sharding-default
# below), no limit (full 500).
set -euo pipefail

VARIANT="s"
# @anchor sharding-default — empirically 2 is the safe default on a
# 7.6 GiB WSL2 system. Each in-process bench daemon holds ~1.3 GB RSS
# (better-sqlite3 + materialization router + dataset in memory), so
# shards=4 has OOM-killed processes in practice on a system with ~3 GB
# free. The /proc/meminfo guard below auto-downgrades the requested
# shard count to whatever the available memory budget supports
# (~1500 MB reserved per shard).
SHARDS=""
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

# @anchor memory-guard — cap shards by /proc/meminfo so an operator
# requesting more than memory can support is automatically downgraded
# rather than OOM-killed mid-run. Each shard reserves ~1500 MB.
PER_SHARD_MB=1500
DEFAULT_SHARDS=2
REQUESTED_SHARDS="${SHARDS:-$DEFAULT_SHARDS}"
if [[ -r /proc/meminfo ]]; then
  AVAIL_KB=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
  AVAIL_MB=$(( AVAIL_KB / 1024 ))
  MAX_BY_MEM=$(( AVAIL_MB / PER_SHARD_MB ))
  if (( MAX_BY_MEM < 1 )); then MAX_BY_MEM=1; fi
else
  AVAIL_MB="unknown"
  MAX_BY_MEM=$REQUESTED_SHARDS
fi
if (( REQUESTED_SHARDS > MAX_BY_MEM )); then
  echo "[$(date -u -Iseconds)] memory guard: requested shards=$REQUESTED_SHARDS but available_mb=$AVAIL_MB only supports $MAX_BY_MEM at ${PER_SHARD_MB}MB/shard; downgrading to $MAX_BY_MEM" >&2
  SHARDS=$MAX_BY_MEM
else
  SHARDS=$REQUESTED_SHARDS
fi
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
