#!/usr/bin/env bash
# Unified LongMemEval matrix cell entry.
# Required: MATRIX_RUN_ROOT (campaign dir with snapshot/source-100.db).
# Optional: MATRIX_CACHE_ROOT, MATRIX_MODEL_CACHE, MATRIX_DATASET_DIR,
#           MATRIX_SNAPSHOT, MATRIX_CONTRACT, ALAYA_RECALL_WEIGHT_OVERRIDES,
#           MATRIX_EXTRACTION_MODEL (must equal cache manifest),
#           MATRIX_PASSTHROUGH_ENV (space-separated extra env keys),
#           MATRIX_EXPERIMENT=1 for the contract-free local path,
#           MATRIX_LIMIT / MATRIX_OFFSET for experiment-only slices.
set -euo pipefail

CELL="${1:-}"
case "$CELL" in
  A)  EMBEDDING_MODE=disabled; CROSS_ENABLED=false; EVIDENCE_NAME=cell-a ;;
  B)  EMBEDDING_MODE=env;      CROSS_ENABLED=false; EVIDENCE_NAME=cell-b ;;
  *) echo "usage: $0 A|B" >&2; exit 64 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUN_ROOT="${MATRIX_RUN_ROOT:?MATRIX_RUN_ROOT is required}"
EXPERIMENT="${MATRIX_EXPERIMENT:-0}"
[[ "$EXPERIMENT" == "0" || "$EXPERIMENT" == "1" ]] || {
  echo "MATRIX_EXPERIMENT must be 0 or 1" >&2; exit 64;
}
if [[ "$EXPERIMENT" == "1" && -n "${ALAYA_RECALL_WEIGHT_OVERRIDES:-}" ]]; then
  echo "local experiment requires default recall weights" >&2
  exit 64
fi
SLICE_LIMIT="${MATRIX_LIMIT:-}"
SLICE_OFFSET="${MATRIX_OFFSET:-0}"
if [[ -n "$SLICE_LIMIT" ]]; then
  [[ "$EXPERIMENT" == "1" ]] || {
    echo "MATRIX_LIMIT is experiment-only" >&2; exit 64;
  }
  [[ "$SLICE_LIMIT" =~ ^[1-9][0-9]*$ && "$SLICE_OFFSET" =~ ^[0-9]+$ ]] || {
    echo "MATRIX_LIMIT must be positive and MATRIX_OFFSET nonnegative" >&2; exit 64;
  }
elif [[ "${MATRIX_OFFSET+x}" == "x" ]]; then
  echo "MATRIX_OFFSET requires MATRIX_LIMIT" >&2
  exit 64
fi
CACHE_ROOT="${MATRIX_CACHE_ROOT:-$WORKTREE/.do-it/bench-runs/seeds/longmemeval-s-extraction-cache/deepseek-v4-flash-newapi-nonthinking/cache}"
DATASET_DIR="${MATRIX_DATASET_DIR:-$WORKTREE/apps/bench-runner/data/longmemeval}"
DATASET="$DATASET_DIR/longmemeval_s.json"
MODEL_CACHE="${MATRIX_MODEL_CACHE:-${HOME:-/home/tdwhere}/.cache/do-soul-alaya/models}"
SNAPSHOT="${MATRIX_SNAPSHOT:-$RUN_ROOT/snapshot/source-100.db}"
CONTRACT="${MATRIX_CONTRACT:-$RUN_ROOT/matrix-promotion-contract.json}"
DATA_ROOT="$RUN_ROOT/matrix-data/$CELL"
HISTORY_ROOT="$RUN_ROOT/staging/$CELL"
EVIDENCE_ROOT="$RUN_ROOT/evidence/$EVIDENCE_NAME"
IDENTITY_PATH="$RUN_ROOT/$CELL.runner-identity.json"

file_sha() {
  sha256sum "$1" | cut -d " " -f 1
}

# Snapshot and dataset identity are verified by recall-eval again before restore.
[[ -f "$SNAPSHOT" ]] || { echo "missing snapshot: $SNAPSHOT" >&2; exit 65; }
[[ -f "$DATASET" ]] || { echo "missing dataset: $DATASET" >&2; exit 65; }
if [[ "$EXPERIMENT" == "1" ]]; then
  for artifact in \
    "$SNAPSHOT.manifest.json" \
    "$SNAPSHOT.sidecar.json" \
    "$SNAPSHOT.extraction-authority.json"; do
    [[ -f "$artifact" ]] || { echo "missing snapshot artifact: $artifact" >&2; exit 65; }
  done
else
  [[ -f "$CONTRACT" ]] || { echo "missing promotion contract: $CONTRACT" >&2; exit 65; }
  [[ -f "$CACHE_ROOT/manifest.json" ]] || {
    echo "missing extraction cache manifest" >&2; exit 65;
  }
fi
[[ ! -e "$DATA_ROOT" && ! -e "$HISTORY_ROOT" && ! -e "$EVIDENCE_ROOT" ]] || {
  echo "cell output already exists: $CELL under $RUN_ROOT" >&2; exit 65;
}
MODEL_MANIFEST="$CACHE_ROOT/manifest.json"
if [[ "$EXPERIMENT" == "1" ]]; then
  MODEL_MANIFEST="$SNAPSHOT.manifest.json"
fi
declare -a MODEL_ARGS=("$MODEL_MANIFEST")
if [[ -n "${MATRIX_EXTRACTION_MODEL:-}" ]]; then
  MODEL_ARGS+=("$MATRIX_EXTRACTION_MODEL")
fi
EXTRACTION_MODEL="$(
  rtk node "$SCRIPT_DIR/longmemeval-matrix-cache-model.mjs" "${MODEL_ARGS[@]}"
)"

HEAD_SHA="$(git -C "$WORKTREE" rev-parse HEAD)"
PORCELAIN="$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=normal || true)"
if [[ -z "$PORCELAIN" ]]; then WORKTREE_CLEAN=true; else WORKTREE_CLEAN=false; fi
WORKTREE_STATE_SHA256="$({
  printf '%s\n' "$HEAD_SHA"
  printf '%s' "$PORCELAIN"
} | sha256sum | cut -d ' ' -f 1)"
DIST_JSON="$(node "$WORKTREE/apps/bench-runner/scripts/executed-dist-closure.mjs" --root "$WORKTREE")"
INPUT_IDENTITY_JSON=""
SNAPSHOT_SHA256=""
CACHE_MANIFEST_SHA256=""
DATASET_SHA256=""
if [[ "$EXPERIMENT" == "1" ]]; then
  INPUT_IDENTITY_JSON="$(
    rtk node "$SCRIPT_DIR/longmemeval-experiment-identity.mjs" \
      snapshot "$SNAPSHOT" "$DATASET"
  )"
else
  SNAPSHOT_SHA256="$(file_sha "$SNAPSHOT")"
  CACHE_MANIFEST_SHA256="$(file_sha "$CACHE_ROOT/manifest.json")"
  DATASET_SHA256="$(file_sha "$DATASET")"
fi

mkdir -p "$RUN_ROOT"
CELL="$CELL" RUN_ROOT="$RUN_ROOT" HEAD_SHA="$HEAD_SHA" EXPERIMENT="$EXPERIMENT" \
  WORKTREE_CLEAN="$WORKTREE_CLEAN" WORKTREE_STATE_SHA256="$WORKTREE_STATE_SHA256" \
  DIST_JSON="$DIST_JSON" EMBEDDING_MODE="$EMBEDDING_MODE" CROSS_ENABLED="$CROSS_ENABLED" \
  INPUT_IDENTITY_JSON="$INPUT_IDENTITY_JSON" \
  SNAPSHOT_SHA256="$SNAPSHOT_SHA256" CACHE_MANIFEST_SHA256="$CACHE_MANIFEST_SHA256" \
  DATASET_SHA256="$DATASET_SHA256" \
  EXTRACTION_MODEL="$EXTRACTION_MODEL" \
  SLICE_LIMIT="$SLICE_LIMIT" SLICE_OFFSET="$SLICE_OFFSET" \
  ALAYA_RECALL_WEIGHT_OVERRIDES="${ALAYA_RECALL_WEIGHT_OVERRIDES:-}" \
  python3 - "$IDENTITY_PATH" <<'PY'
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
path = sys.argv[1]
runner = {
  "commit_sha": os.environ["HEAD_SHA"],
  "commit_sha7": os.environ["HEAD_SHA"][:7],
  "worktree_clean": os.environ["WORKTREE_CLEAN"] == "true",
  "worktree_state_sha256": os.environ["WORKTREE_STATE_SHA256"],
  "executed_dist": json.loads(os.environ["DIST_JSON"]),
}
payload = {
  "schema_version": 2 if os.environ["EXPERIMENT"] == "1" else 1,
  "kind": "longmemeval_matrix_cell_runner_identity",
  "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
  "cell": os.environ["CELL"],
  "run_root": os.environ["RUN_ROOT"],
  "runner": runner,
  "treatment": {
    "extraction_model": os.environ["EXTRACTION_MODEL"],
    "embedding_mode": os.environ["EMBEDDING_MODE"],
    "cross_encoder_enabled": os.environ["CROSS_ENABLED"] == "true",
  },
  "weight_overrides": None,
}
if os.environ["EXPERIMENT"] == "1":
  payload["mode"] = "experiment"
  payload["evaluation_slice"] = {
    "offset": int(os.environ["SLICE_OFFSET"]),
    "limit": int(os.environ["SLICE_LIMIT"]) if os.environ["SLICE_LIMIT"] else None,
  }
  payload.update(json.loads(os.environ["INPUT_IDENTITY_JSON"]))
else:
  payload.update({
    "snapshot_sha256": os.environ["SNAPSHOT_SHA256"],
    "cache_manifest_sha256": os.environ["CACHE_MANIFEST_SHA256"],
    "dataset_sha256": os.environ["DATASET_SHA256"],
  })
raw_overrides = os.environ.get("ALAYA_RECALL_WEIGHT_OVERRIDES") or ""
if raw_overrides:
  payload["weight_overrides"] = {
    "sha256": hashlib.sha256(raw_overrides.encode("utf-8")).hexdigest(),
    "json": raw_overrides,
  }
with open(path, "w", encoding="utf-8") as handle:
  json.dump(payload, handle, indent=2, sort_keys=True)
  handle.write("\n")
PY

declare -a PASSTHROUGH_ARGS=(
  "PATH=$PATH"
  "HOME=${HOME:-/home/tdwhere}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "LANG=${LANG:-C.UTF-8}"
  "LC_ALL=${LC_ALL:-C.UTF-8}"
  "TZ=UTC"
  "NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=4096}"
)
if [[ -n "${ALAYA_RECALL_WEIGHT_OVERRIDES:-}" ]]; then
  PASSTHROUGH_ARGS+=("ALAYA_RECALL_WEIGHT_OVERRIDES=$ALAYA_RECALL_WEIGHT_OVERRIDES")
fi
for key in ${MATRIX_PASSTHROUGH_ENV:-}; do
  if [[ -n "${!key:-}" ]]; then
    PASSTHROUGH_ARGS+=("$key=${!key}")
  fi
done

declare -a AUTHORITY_ARGS=()
declare -a CACHE_ARGS=()
declare -a CLI_ARGS=()
if [[ "$EXPERIMENT" == "1" ]]; then
  CLI_ARGS+=(--experiment)
else
  GATE_SHA256="$(file_sha "$CONTRACT")"
  AUTHORITY_ARGS+=(
    "ALAYA_BENCH_GATE_CONTRACT_PATH=$CONTRACT"
    "ALAYA_BENCH_GATE_SHA256=$GATE_SHA256"
    "ALAYA_BENCH_WORKTREE_STATE_SHA256=$WORKTREE_STATE_SHA256"
  )
  CACHE_ARGS+=(
    "ALAYA_BENCH_EXTRACTION_CACHE_ROOT=$CACHE_ROOT"
    "ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE=1"
  )
fi
if [[ -n "$SLICE_LIMIT" ]]; then
  CLI_ARGS+=(--limit "$SLICE_LIMIT" --offset "$SLICE_OFFSET")
fi

cd "$WORKTREE"
set +e
/usr/bin/env -i \
  "${PASSTHROUGH_ARGS[@]}" \
  "${AUTHORITY_ARGS[@]}" \
  "${CACHE_ARGS[@]}" \
  ALAYA_BENCH_ALLOW_LIVE_EXTRACTION=0 \
  OFFICIAL_API_GARDEN_MODEL="$EXTRACTION_MODEL" \
  ALAYA_GARDEN_PROVIDER_KIND=host_worker \
  ALAYA_RECALL_EVAL_EMBEDDING="$EMBEDDING_MODE" \
  ALAYA_EMBEDDING_PROVIDER=local_onnx \
  ALAYA_LOCAL_EMBEDDING_CACHE_DIR="$MODEL_CACHE" \
  ALAYA_LOCAL_EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2 \
  ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK="$CROSS_ENABLED" \
  ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR="$MODEL_CACHE" \
  ALAYA_LOCAL_CROSS_ENCODER_MODEL=Xenova/ms-marco-MiniLM-L-6-v2 \
  ALAYA_RECALL_D2Q=false \
  ALAYA_RECALL_SOURCE_REF_ROBUST=true \
  ALAYA_RECALL_ANSWERS_WITH=1 \
  ALAYA_RECALL_EVAL_MAX_RESULTS=10 \
  rtk node apps/bench-runner/bin/alaya-bench-runner.mjs recall-eval \
    --snapshot "$SNAPSHOT" \
    --variant s \
    --policy-shape stress \
    --simulate-report none \
    --data-dir "$DATASET_DIR" \
    --data-dir-root "$DATA_ROOT" \
    --history-root "$HISTORY_ROOT" \
    "${CLI_ARGS[@]}"
status=$?
set -e

if (( status > 1 )); then
  exit "$status"
fi
mapfile -d '' entries < <(
  find "$HISTORY_ROOT/public" -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -print0
)
[[ "${#entries[@]}" -eq 1 ]] || { echo "expected exactly one committed evidence entry" >&2; exit 65; }
mkdir -p "$(dirname "$EVIDENCE_ROOT")"
mv "${entries[0]}" "$EVIDENCE_ROOT"
if [[ -f "$EVIDENCE_ROOT/kpi.json" ]]; then
  echo "kpi: $EVIDENCE_ROOT/kpi.json" >&2
fi
exit "$status"
