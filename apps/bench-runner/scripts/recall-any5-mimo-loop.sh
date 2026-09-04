#!/usr/bin/env bash
# Pinned MiMo operator entry for this campaign.
# Ad-hoc one-liners drift identity (profile, secrets, limit). This script is
# the only supported way to replay, fill query factors, or run diagnostic-loop.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BIN="$WT/apps/bench-runner/bin/alaya-bench-runner.mjs"
DEFAULT_ENV="$WT/.do-it/bench-env/mimo-v2.5-opencode-go.env"
SMALL_WINDOW_CEILING=3

usage() {
  cat <<'EOF'
usage: recall-any5-mimo-loop.sh <replay|query-factor-fill|diagnostic|inspect-seed> --limit N [--offset N] [--confirm-window N] [--canary-unlock PATH] [--snapshot PATH] [--embedding-cache-overlay PATH]

  --limit is required. Windows larger than 3 also need --confirm-window equal
  to that limit and --canary-unlock <3q-work-root> from a current canary
  polarity-matrix pass. That unlock is diagnostic-only, not an Any@5 KPI.

  replay             cache-only provider-preflight + full-window zero-call proof
  query-factor-fill  live query-compiler fill (API). Needs credentials.
  diagnostic         cache-only credentialless diagnostic-loop
  inspect-seed       print projection artifact inflation from a seed sqlite
  --snapshot PATH    diagnostic reuse of a sealed DB; omits --snapshot-out
  --embedding-cache-overlay PATH  diagnostic-only overlay receipt for read-mostly
                     embedding-on recall (frozen snapshot stays 0-vector)
EOF
}

die() { echo "recall-any5-mimo-loop: $*" >&2; exit 2; }

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] || { usage; exit 2; }
shift

LIMIT=""
OFFSET="0"
CONFIRM_WINDOW=""
WORK_ROOT=""
SEED_DB=""
SNAPSHOT=""
SNAPSHOT_FLAG=0
EMBEDDING_CACHE_OVERLAY=""
CANARY_UNLOCK=""
TEMP_REQUEST_FILE=""
TEMP_RECEIPT_FILE=""

cleanup_temp_request() {
  if [[ -n "$TEMP_REQUEST_FILE" ]]; then
    rm -f -- "$TEMP_REQUEST_FILE"
  fi
  if [[ -n "$TEMP_RECEIPT_FILE" ]]; then
    rm -f -- "$TEMP_RECEIPT_FILE"
  fi
}
trap cleanup_temp_request EXIT

clear_provider_credentials() {
  unset ALAYA_OFFICIAL_GARDEN_SECRET_REF ALAYA_OFFICIAL_GARDEN_API_KEY
  unset OFFICIAL_API_GARDEN_API_KEY ALAYA_QA_API_KEY
  unset ALAYA_GARDEN_OPENAI_SECRET_REF
  unset ALAYA_CONFLICT_LLM_PROVIDER_URL ALAYA_CONFLICT_LLM_API_KEY
  export ALAYA_BENCH_ALLOW_LIVE_EXTRACTION=0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="${2:-}"; shift 2 ;;
    --offset) OFFSET="${2:-}"; shift 2 ;;
    --confirm-window) CONFIRM_WINDOW="${2:-}"; shift 2 ;;
    --canary-unlock) CANARY_UNLOCK="${2:-}"; shift 2 ;;
    --work-root) WORK_ROOT="${2:-}"; shift 2 ;;
    --seed-db) SEED_DB="${2:-}"; shift 2 ;;
    --snapshot)
      # Presence is independent of value so an empty operand cannot materialize.
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == -* ]]; then
        die "--snapshot requires a non-empty path"
      fi
      SNAPSHOT="$2"
      SNAPSHOT_FLAG=1
      shift 2
      ;;
    --embedding-cache-overlay)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == -* ]]; then
        die "--embedding-cache-overlay requires a non-empty path"
      fi
      EMBEDDING_CACHE_OVERLAY="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag $1" ;;
  esac
done

[[ "$COMMAND" == "inspect-seed" ]] || [[ -n "$LIMIT" ]] || die "--limit is required"
if [[ "$COMMAND" != "inspect-seed" ]]; then
  [[ "$LIMIT" =~ ^[0-9]+$ ]] && [[ "$LIMIT" -gt 0 ]] || die "--limit must be a positive integer"
  if [[ "$LIMIT" -gt "$SMALL_WINDOW_CEILING" ]]; then
    if [[ "$CONFIRM_WINDOW" != "$LIMIT" ]]; then
      die "refusing limit=$LIMIT (>$SMALL_WINDOW_CEILING) without --confirm-window $LIMIT"
    fi
    if [[ -z "$CANARY_UNLOCK" ]]; then
      die "refusing limit=$LIMIT without --canary-unlock <3q-work-root>"
    fi
  fi
fi
if [[ "$SNAPSHOT_FLAG" -eq 1 && "$COMMAND" != "diagnostic" ]]; then
  die "--snapshot is only valid for diagnostic"
fi
if [[ -n "$EMBEDDING_CACHE_OVERLAY" && "$COMMAND" != "diagnostic" ]]; then
  die "--embedding-cache-overlay is only valid for diagnostic"
fi

ENV_FILE="${ALAYA_RECALL_ANY5_ENV:-$DEFAULT_ENV}"
[[ -f "$ENV_FILE" ]] || die "env file missing: $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ "${ALAYA_BENCH_RECALL_PACKET_TRACE:-0}" == "1" ]]; then
  die "ALAYA_BENCH_RECALL_PACKET_TRACE=1 is forbidden for the pinned recall-only operator"
fi

CACHE_ROOT="${ALAYA_BENCH_EXTRACTION_CACHE_ROOT:-}"
[[ -n "$CACHE_ROOT" ]] || die "ALAYA_BENCH_EXTRACTION_CACHE_ROOT unset after sourcing env"
G2="$(cd "$(dirname "$CACHE_ROOT")" && pwd)"
MANIFEST="$CACHE_ROOT/manifest.json"

load_identity() {
  [[ -f "$MANIFEST" ]] || die "cache manifest missing: $MANIFEST"
  node - "$MANIFEST" <<'JS'
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const required = [
  "dataset_revision", "extraction_model", "request_profile",
  "system_prompt_sha256", "provider_url"
];
const missing = required.filter((key) => !manifest[key]);
if (missing.length > 0) {
  process.stderr.write(`manifest missing ${JSON.stringify(missing)}\n`);
  process.exit(1);
}
for (const key of required) console.log(manifest[key]);
JS
}

build_canonical_request_manifest() {
  local output="$1" dataset="$2" prompt="$3" provider="$4" model="$5" profile="$6"
  node "$SCRIPT_DIR/prove-cache-only-replay.mjs" \
    "$output" \
    "$dataset" "$prompt" "$CACHE_ROOT" \
    "$LIMIT" "$OFFSET" "$provider" "$model" "$profile"
}

run_replay() {
  local dataset model profile prompt provider
  { read -r dataset; read -r model; read -r profile; read -r prompt
    read -r provider
  } < <(load_identity)
  echo "replay identity model=$model profile=$profile limit=$LIMIT offset=$OFFSET"
  local request_file receipt_file rc=0
  request_file="$(mktemp)"
  receipt_file="$(mktemp)"
  TEMP_REQUEST_FILE="$request_file"
  TEMP_RECEIPT_FILE="$receipt_file"
  clear_provider_credentials
  build_canonical_request_manifest \
    "$request_file" "$dataset" "$prompt" "$provider" "$model" "$profile" || rc=$?
  if [[ $rc -eq 0 ]]; then
    node "$BIN" provider-preflight --mode replay \
      --request-manifest "$request_file" > "$receipt_file" || rc=$?
  fi
  if [[ $rc -eq 0 ]]; then
    node "$BIN" provider-preflight --mode validate-replay-receipt \
      --receipt "$receipt_file" --request-manifest "$request_file" || rc=$?
  fi
  if [[ $rc -eq 0 ]]; then
    cat "$receipt_file"
  fi
  rm -f -- "$request_file"
  rm -f -- "$receipt_file"
  TEMP_REQUEST_FILE=""
  TEMP_RECEIPT_FILE=""
  return "$rc"
}

reject_completed_recall_checkpoints() {
  local work="$1"
  node "$BIN" provider-preflight \
    --mode validate-recall-checkpoints --work-root "$work"
}

run_query_factor_fill() {
  local questions="$G2/questions-${LIMIT}.json"
  local out="$G2/query-factor-cache-${LIMIT}q.json"
  python3 - "$WT/apps/bench-runner/data/longmemeval/longmemeval_s.json" \
    "$questions" "$OFFSET" "$LIMIT" <<'PY'
import json, sys
src, dest, offset, limit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
rows = json.loads(open(src, encoding="utf-8").read())[offset:offset + limit]
open(dest, "w", encoding="utf-8").write(json.dumps(
    [{"question_id": row["question_id"], "question": row["question"]} for row in rows],
    ensure_ascii=False, indent=2
) + "\n")
print(f"wrote {len(rows)} questions -> {dest}")
PY
  export ALAYA_BENCH_ALLOW_LIVE_EXTRACTION=1
  cd "$WT"
  node "$SCRIPT_DIR/fill-query-factors.mjs" "$questions" "$out"
}

prepare_snapshot_args() {
  local work="$1"
  SNAPSHOT_ARGS=()
  if [[ "$SNAPSHOT_FLAG" -eq 1 ]]; then
    [[ -f "$SNAPSHOT" ]] || die "snapshot is not a file: $SNAPSHOT"
    # --snapshot-out would materialize a new DB; reuse must stay read-only.
    SNAPSHOT_ARGS+=(--snapshot "$SNAPSHOT")
  else
    # Default materialize would replace a sealed work DB already on disk.
    if [[ -f "$work/snapshot.db" ]]; then
      die "refusing to overwrite existing snapshot: $work/snapshot.db"
    fi
    SNAPSHOT_ARGS+=(--snapshot-out "$work/snapshot.db")
  fi
}

invoke_cache_only_diagnostic() {
  local work="$1" qcache="$2" request_file="$3"
  # post-fill stages must stay credentialless before history/run mutation
  clear_provider_credentials
  export ALAYA_GARDEN_PROVIDER_KIND=host_worker
  mkdir -p "$work/history"
  local extra=()
  if [[ -f "$qcache" ]]; then
    extra+=(--query-semantic-factor-cache "$qcache")
  fi
  if [[ -n "$CANARY_UNLOCK" ]]; then
    extra+=(--canary-unlock "$CANARY_UNLOCK")
  fi
  if [[ -n "$EMBEDDING_CACHE_OVERLAY" ]]; then
    extra+=(--embedding-cache-overlay "$EMBEDDING_CACHE_OVERLAY")
  fi
  echo "diagnostic cache-only credentialless limit=$LIMIT work=$work"
  node "$BIN" diagnostic-loop \
    --work-root "$work" --request-manifest "$request_file" \
    --mode cache-only "${SNAPSHOT_ARGS[@]}" \
    --history-root "$work/history" "${extra[@]}"
}

run_diagnostic() {
  local dataset model profile prompt provider
  { read -r dataset; read -r model; read -r profile; read -r prompt
    read -r provider
  } < <(load_identity)
  local work="${WORK_ROOT:-$G2/diagnostic-${LIMIT}q-run}"
  local qcache="$G2/query-factor-cache-${LIMIT}q.json"
  # Sealed 100Q query cache is a superset; small windows may reuse it.
  if [[ ! -f "$qcache" && -f "$G2/query-factor-cache-100q.json" ]]; then
    qcache="$G2/query-factor-cache-100q.json"
  fi
  prepare_snapshot_args "$work"
  reject_completed_recall_checkpoints "$work"
  local request_file rc=0
  request_file="$(mktemp)"
  TEMP_REQUEST_FILE="$request_file"
  build_canonical_request_manifest \
    "$request_file" "$dataset" "$prompt" "$provider" "$model" "$profile" || rc=$?
  if [[ $rc -ne 0 ]]; then
    rm -f -- "$request_file"
    TEMP_REQUEST_FILE=""
    return "$rc"
  fi
  invoke_cache_only_diagnostic "$work" "$qcache" "$request_file" || rc=$?
  rm -f -- "$request_file"
  TEMP_REQUEST_FILE=""
  return "$rc"
}

run_inspect() {
  local db="${SEED_DB:-}"
  [[ -n "$db" ]] || die "inspect-seed requires --seed-db"
  python3 - "$db" <<'PY'
import json, sqlite3, sys
from collections import Counter
db = sys.argv[1]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
cur = con.cursor()
print("workspaces", cur.execute("select count(*) from workspaces").fetchone()[0])
print("memory_entries", cur.execute("select count(*) from memory_entries").fetchone()[0])
print("rebuilds", cur.execute(
    "select count(*) from event_log where event_type='soul.field.generation.rebuild_started'"
).fetchone()[0])
rows = cur.execute(
    "select workspace_id, length(artifacts_json) from projection_generation_artifacts"
).fetchall()
print("artifacts", len(rows), "bytes", sum(n for _, n in rows))
if not rows:
    raise SystemExit(0)
ws, _ = max(rows, key=lambda item: item[1])
obj = json.loads(cur.execute(
    "select artifacts_json from projection_generation_artifacts where workspace_id=?",
    (ws,)
).fetchone()[0])
vals = Counter(key["normalized_value"] for key in obj["slice_keys"])
print("largest_workspace", ws)
print("policy", obj.get("policy"))
print("postings", len(obj["postings"]), "bundles", len(obj["bundles"]),
      "slice_keys", len(obj["slice_keys"]), "unique_values", len(vals))
print("top_values", vals.most_common(12))
con.close()
PY
}

case "$COMMAND" in
  replay) run_replay ;;
  query-factor-fill) run_query_factor_fill ;;
  diagnostic) run_diagnostic ;;
  inspect-seed) run_inspect ;;
  *) usage; die "unknown command $COMMAND" ;;
esac
