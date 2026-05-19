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
#     [--variant s|oracle] [--embedding disabled|env] [--shards N] [--limit M] [--policy-shape stress|chat] \
#     [--simulate-report none|always-used|gold-only|mixed] [--weights '<json>'] [--history-root path]
#
# Defaults: variant=s, embedding=disabled+env sequentially,
# policy_shape=stress+chat sequentially, simulate_report=none, shards=2
# (memory-guarded per shape; see @anchor sharding-default below), no limit (full 500).
set -euo pipefail

VARIANT="s"
EMBEDDING=""
EMBEDDING_SPECIFIED=0
POLICY_SHAPE=""
POLICY_SHAPE_SPECIFIED=0
SIMULATE_REPORT="none"
# @anchor sharding-default — empirically 2 is the safe default on a
# 7.6 GiB WSL2 system. Each in-process bench daemon holds ~1.3 GB RSS
# (better-sqlite3 + materialization router + dataset in memory), so
# shards=4 has OOM-killed processes in practice on a system with ~3 GB
# free. The /proc/meminfo guard below auto-downgrades the requested
# shard count to whatever the available memory budget supports
# (~1500 MB reserved per shard).
SHARDS=""
LIMIT=""
WEIGHTS=""
HISTORY_ROOT="${BENCH_PUBLIC_HISTORY_ROOT:-docs/bench-history}"
LOG_DIR="${BENCH_LOG_DIR:-/tmp/alaya-bench-logs}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant) VARIANT="$2"; shift 2;;
    --embedding) EMBEDDING="$2"; EMBEDDING_SPECIFIED=1; shift 2;;
    --policy-shape) POLICY_SHAPE="$2"; POLICY_SHAPE_SPECIFIED=1; shift 2;;
    --simulate-report) SIMULATE_REPORT="$2"; shift 2;;
    --weights) WEIGHTS="$2"; shift 2;;
    --shards) SHARDS="$2"; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    --history-root) HISTORY_ROOT="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

if (( POLICY_SHAPE_SPECIFIED == 1 )); then
  case "$POLICY_SHAPE" in
    stress|chat) ;;
    *) echo "unknown policy shape: $POLICY_SHAPE" >&2; exit 2;;
  esac
  POLICY_SHAPES=("$POLICY_SHAPE")
else
  POLICY_SHAPES=("stress" "chat")
fi

if (( EMBEDDING_SPECIFIED == 1 )); then
  case "$EMBEDDING" in
    disabled|env) ;;
    *) echo "unknown embedding mode: $EMBEDDING" >&2; exit 2;;
  esac
  EMBEDDINGS=("$EMBEDDING")
else
  EMBEDDINGS=("disabled" "env")
fi

requires_env_embedding=0
for embedding in "${EMBEDDINGS[@]}"; do
  if [[ "$embedding" == "env" ]]; then
    requires_env_embedding=1
  fi
done

if (( requires_env_embedding == 1 )); then
  secret_ref="${ALAYA_OPENAI_SECRET_REF:-env:OPENAI_API_KEY}"
  case "$secret_ref" in
    env:*)
      secret_var="${secret_ref#env:}"
      if [[ -z "$secret_var" || -z "${!secret_var:-}" ]]; then
        echo "--embedding env requires ALAYA_OPENAI_SECRET_REF or a non-empty OPENAI_API_KEY; missing env:${secret_var:-OPENAI_API_KEY}" >&2
        exit 2
      fi
      ;;
    file:*)
      secret_file="${secret_ref#file:}"
      if [[ -z "$secret_file" || ! -r "$secret_file" || ! -s "$secret_file" ]]; then
        echo "--embedding env requires a readable non-empty secret file from ALAYA_OPENAI_SECRET_REF" >&2
        exit 2
      fi
      ;;
    keychain:*) ;;
    *)
      echo "--embedding env requires ALAYA_OPENAI_SECRET_REF to use env:, file:, or keychain:" >&2
      exit 2
      ;;
  esac
fi

case "$SIMULATE_REPORT" in
  none|always-used|gold-only|mixed) ;;
  *) echo "unknown simulate-report mode: $SIMULATE_REPORT" >&2; exit 2;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
BENCH_COMMIT_SHA7="${BENCH_COMMIT_SHA7:-$(git rev-parse --short HEAD 2>/dev/null || echo 0000000)}"
export BENCH_COMMIT_SHA7

mkdir -p "$LOG_DIR"

# Resolve total sample size by reading the pinned meta (avoid loading the
# full dataset JSON in the driver). Dataset variants are pinned under
# docs/bench-history/datasets/<variant>.meta.json.
case "$VARIANT" in
  oracle) META="docs/bench-history/datasets/longmemeval_oracle.meta.json";;
  s) META="docs/bench-history/datasets/longmemeval_s.meta.json";;
  m) META="docs/bench-history/datasets/longmemeval_m.meta.json";;
  *) echo "unknown variant: $VARIANT" >&2; exit 2;;
esac
TOTAL=$(node -e "const d=JSON.parse(require('fs').readFileSync('$META','utf8'));console.log(d.question_count);")
EFFECTIVE_TOTAL="${LIMIT:-$TOTAL}"

run_one() {
  local embedding="$1"
  local policy_shape="$2"

  # @anchor memory-guard — cap shards by /proc/meminfo so an operator
  # requesting more than memory can support is automatically downgraded
  # rather than OOM-killed mid-run. Each shard reserves ~1500 MB.
  local per_shard_mb=1500
  local default_shards=2
  local requested_shards="${SHARDS:-$default_shards}"
  local avail_mb
  local max_by_mem
  if [[ -r /proc/meminfo ]]; then
    local avail_kb
    avail_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
    avail_mb=$(( avail_kb / 1024 ))
    max_by_mem=$(( avail_mb / per_shard_mb ))
    if (( max_by_mem < 1 )); then max_by_mem=1; fi
  else
    avail_mb="unknown"
    max_by_mem=$requested_shards
  fi

  local shards_for_run
  if (( requested_shards > max_by_mem )); then
    echo "[$(date -u -Iseconds)] memory guard: requested shards=$requested_shards but available_mb=$avail_mb only supports $max_by_mem at ${per_shard_mb}MB/shard; downgrading to $max_by_mem" >&2
    shards_for_run=$max_by_mem
  else
    shards_for_run=$requested_shards
  fi

  local ts
  ts="$(date -u '+%Y-%m-%dT%H%M%SZ')"
  local run_tag="longmemeval_${VARIANT}_${embedding}_${policy_shape}_report-${SIMULATE_REPORT}_s${shards_for_run}_${ts}"
  local master_log="$LOG_DIR/${run_tag}.log"

  # Shard size: ceil(effective_total / shards_for_run)
  local shard_size=$(( (EFFECTIVE_TOTAL + shards_for_run - 1) / shards_for_run ))

  echo "[$(date -u -Iseconds)] driver=$run_tag variant=$VARIANT embedding=$embedding policy_shape=$policy_shape simulate_report=$SIMULATE_REPORT shards=$shards_for_run total=$EFFECTIVE_TOTAL shard_size=$shard_size weights=${WEIGHTS:-none}" | tee "$master_log"

  local -a shard_pids=()
  local -a shard_roots=()
  local start
  start=$(date +%s)

  for ((i=0; i<shards_for_run; i++)); do
    local offset=$((i * shard_size))
    if (( offset >= EFFECTIVE_TOTAL )); then break; fi
    local remain=$((EFFECTIVE_TOTAL - offset))
    local slice=$(( remain < shard_size ? remain : shard_size ))
    local shard_root="/tmp/alaya-bench-shards/${run_tag}/shard-${i}"
    local shard_log="$LOG_DIR/${run_tag}_shard${i}.log"
    local -a weights_args=()
    if [[ -n "$WEIGHTS" ]]; then
      weights_args=(--weights "$WEIGHTS")
    fi
    mkdir -p "$shard_root"
    shard_roots+=("$shard_root")
    echo "[$(date -u -Iseconds)] launching shard $i offset=$offset limit=$slice root=$shard_root log=$shard_log" | tee -a "$master_log"
    (
      node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval \
        --variant "$VARIANT" \
        --offset "$offset" \
        --limit "$slice" \
        --embedding "$embedding" \
        --policy-shape "$policy_shape" \
        --simulate-report "$SIMULATE_REPORT" \
        "${weights_args[@]}" \
        --history-root "$shard_root" \
        >"$shard_log" 2>&1
    ) &
    shard_pids+=("$!")
  done

  echo "[$(date -u -Iseconds)] waiting for ${#shard_pids[@]} shard(s)..." | tee -a "$master_log"
  local exit_fail=0
  for pid in "${shard_pids[@]}"; do
    if ! wait "$pid"; then
      echo "[$(date -u -Iseconds)] shard pid=$pid exited non-zero" | tee -a "$master_log"
      exit_fail=1
    fi
  done

  local end
  end=$(date +%s)
  local elapsed=$((end - start))
  echo "[$(date -u -Iseconds)] all shards complete elapsed=${elapsed}s exit_fail=$exit_fail" | tee -a "$master_log"

  if (( exit_fail != 0 )); then
    echo "one or more shards failed — skipping merge" | tee -a "$master_log"
    return 1
  fi

  echo "[$(date -u -Iseconds)] merging shards..." | tee -a "$master_log"
  node apps/bench-runner/bin/alaya-bench-runner.mjs merge-longmemeval \
    --variant "$VARIANT" \
    --shards "${shard_roots[@]}" \
    --history-root "$HISTORY_ROOT" \
    2>&1 | tee -a "$master_log"

  echo "[$(date -u -Iseconds)] driver done. master log=$master_log" | tee -a "$master_log"
}

for embedding in "${EMBEDDINGS[@]}"; do
  for policy_shape in "${POLICY_SHAPES[@]}"; do
    run_one "$embedding" "$policy_shape"
  done
done
