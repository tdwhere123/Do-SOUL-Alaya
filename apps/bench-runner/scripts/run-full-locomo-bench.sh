#!/usr/bin/env bash
# @anchor full-locomo-bench-runner — LoCoMo full set with embedding modes

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
BENCH_COMMIT_SHA7="${BENCH_COMMIT_SHA7:-$(git rev-parse --short HEAD 2>/dev/null || echo 0000000)}"
export BENCH_COMMIT_SHA7

EMBEDDING=""
EMBEDDING_SPECIFIED=0
LIMIT=""
OFFSET=""
HISTORY_ROOT="${BENCH_LOCOMO_HISTORY_ROOT:-docs/bench-history}"
LOG_DIR="${BENCH_LOG_DIR:-/tmp/alaya-bench-logs}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --embedding) EMBEDDING="$2"; EMBEDDING_SPECIFIED=1; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    --offset) OFFSET="$2"; shift 2;;
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
fi

mkdir -p "$LOG_DIR"

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

  echo "[$(date -u -Iseconds)] locomo full embedding=$embedding limit=${LIMIT:-full} offset=${OFFSET:-0}" | tee "$log"
  node apps/bench-runner/bin/alaya-bench-runner.mjs locomo \
    --embedding "$embedding" \
    "${optional_args[@]}" \
    --history-root "$HISTORY_ROOT" \
    2>&1 | tee -a "$log"
}

for embedding in "${EMBEDDINGS[@]}"; do
  run_one "$embedding"
done
