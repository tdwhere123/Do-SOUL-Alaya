#!/usr/bin/env bash
# @anchor full-locomo-bench-runner — LoCoMo full set with embedding modes
#
# Usage:
#   apps/bench-runner/scripts/run-full-locomo-bench.sh \
#     [--embedding disabled|env] [--limit M] [--offset N] [--data-dir path] [--history-root path]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
BENCH_COMMIT_SHA7="${BENCH_COMMIT_SHA7:-$(git rev-parse --short HEAD 2>/dev/null || echo 0000000)}"
export BENCH_COMMIT_SHA7

EMBEDDING=""
EMBEDDING_SPECIFIED=0
LIMIT=""
OFFSET=""
DATA_DIR="${BENCH_LOCOMO_DATA_DIR:-apps/bench-runner/data/locomo}"
HISTORY_ROOT="${BENCH_LOCOMO_HISTORY_ROOT:-docs/bench-history}"
LOG_DIR="${BENCH_LOG_DIR:-/tmp/alaya-bench-logs}"
NODE_BIN="${BENCH_NODE_BIN:-node}"
NODE_RUNNER=("$NODE_BIN")
if [[ "${BENCH_NODE_USE_ENV_PROXY:-0}" == "1" ]]; then
  NODE_RUNNER+=(--use-env-proxy)
fi
BENCH_RUNNER_CLI="apps/bench-runner/dist/cli/index.js"

runtime_dist_for_src() {
  local src="$1"
  local base=""
  local rel=""
  local dist=""
  case "$src" in
    apps/bench-runner/src/*)
      base="apps/bench-runner"
      rel="${src#apps/bench-runner/src/}"
      dist="$base/dist/$rel"
      ;;
    apps/core-daemon/src/*)
      base="apps/core-daemon"
      rel="${src#apps/core-daemon/src/}"
      dist="$base/dist/$rel"
      ;;
    packages/*/src/*)
      base="${src%%/src/*}"
      rel="${src#"$base"/src/}"
      dist="$base/dist/$rel"
      ;;
    *)
      dist=""
      ;;
  esac
  case "$dist" in
    *.tsx) dist="${dist%.tsx}.js" ;;
    *.ts) dist="${dist%.ts}.js" ;;
  esac
  printf '%s' "$dist"
}

ensure_bench_runner_build_fresh() {
  if [[ ! -f "$BENCH_RUNNER_CLI" ]]; then
    echo "bench runner dist is missing: $BENCH_RUNNER_CLI" >&2
    echo "Run: rtk pnpm build" >&2
    exit 2
  fi

  local checked_dirs=(
    "apps/bench-runner/src"
    "apps/core-daemon/src"
    "packages/core/src"
    "packages/eval/src"
    "packages/protocol/src"
    "packages/soul/src"
    "packages/storage/src"
  )
  local stale_src=""
  local stale_dist=""
  local dir=""
  for dir in "${checked_dirs[@]}"; do
    [[ -d "$dir" ]] || continue
    while IFS= read -r -d '' src; do
      local dist
      dist="$(runtime_dist_for_src "$src")"
      if [[ -z "$dist" || ! -f "$dist" || "$src" -nt "$dist" ]]; then
        stale_src="$src"
        stale_dist="$dist"
        break
      fi
    done < <(find "$dir" -type f \( -name '*.ts' -o -name '*.tsx' \) \
      ! -path '*/__tests__/*' \
      ! -name '*.test.ts' \
      ! -name '*.test.tsx' \
      -print0)
    [[ -z "$stale_src" ]] || break
  done

  if [[ -n "$stale_src" ]]; then
    echo "bench runner dist appears stale: $stale_src is newer than ${stale_dist:-its dist output}" >&2
    echo "Run: rtk pnpm build" >&2
    exit 2
  fi
}

ensure_bench_runner_build_fresh

while [[ $# -gt 0 ]]; do
  case "$1" in
    --embedding) EMBEDDING="$2"; EMBEDDING_SPECIFIED=1; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    --offset) OFFSET="$2"; shift 2;;
    --data-dir) DATA_DIR="$2"; shift 2;;
    --history-root) HISTORY_ROOT="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

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

  "${NODE_RUNNER[@]}" apps/bench-runner/bin/embedding-provider-preflight.mjs
fi

mkdir -p "$LOG_DIR"

META="docs/bench-history/datasets/locomo10.meta.json"
DATASET_JSON="$DATA_DIR/locomo10.json"
SCRATCH_META="$DATA_DIR/locomo10.meta.json"
printf -v warmup_command 'rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-locomo --data-dir %q' "$DATA_DIR"
printf -v refresh_command 'rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-locomo --data-dir %q --force' "$DATA_DIR"
if [[ ! -r "$META" ]]; then
  echo "pinned dataset meta missing or unreadable: $META" >&2
  exit 2
fi
if [[ ! -r "$DATASET_JSON" ]]; then
  echo "dataset cache missing: $DATASET_JSON" >&2
  echo "warm it first with: $warmup_command" >&2
  exit 2
fi
if [[ ! -r "$SCRATCH_META" ]]; then
  echo "dataset scratch meta missing: $SCRATCH_META" >&2
  echo "warm it first with: $warmup_command" >&2
  exit 2
fi
PINNED_SHA=$("${NODE_RUNNER[@]}" -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if (!p.sha256) throw new Error('missing sha256'); process.stdout.write(p.sha256);" "$META")
ACTUAL_SHA=$("${NODE_RUNNER[@]}" -e "const fs=require('fs');const crypto=require('crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'));" "$DATASET_JSON")
if [[ "$ACTUAL_SHA" != "$PINNED_SHA" ]]; then
  echo "dataset checksum mismatch: locomo10 pinned=$PINNED_SHA actual=$ACTUAL_SHA" >&2
  echo "refresh the cache with: $refresh_command" >&2
  exit 2
fi

run_one() {
  local embedding="$1"
  local ts
  ts="$(date -u '+%Y-%m-%dT%H%M%SZ')"
  local log="$LOG_DIR/full_locomo_${embedding}_${ts}.log"
  local -a optional_args=()
  if [[ -n "$LIMIT" ]]; then
    optional_args+=(--limit "$LIMIT")
  fi
  if [[ -n "$OFFSET" ]]; then
    optional_args+=(--offset "$OFFSET")
  fi

  echo "[$(date -u -Iseconds)] locomo full embedding=$embedding limit=${LIMIT:-full} offset=${OFFSET:-0} data_dir=$DATA_DIR" | tee "$log"
  "${NODE_RUNNER[@]}" apps/bench-runner/bin/alaya-bench-runner.mjs locomo \
    --embedding "$embedding" \
    "${optional_args[@]}" \
    --data-dir "$DATA_DIR" \
    --history-root "$HISTORY_ROOT" \
    2>&1 | tee -a "$log"
}

for embedding in "${EMBEDDINGS[@]}"; do
  run_one "$embedding"
done
