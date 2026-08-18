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
usage: recall-any5-mimo-loop.sh <replay|query-factor-fill|diagnostic|inspect-seed> --limit N [--offset N] [--confirm-window N]

  --limit is required. Windows larger than 3 also need --confirm-window equal
  to that limit. 100Q is refused unless you pass --confirm-window 100 after a
  1-3Q proof.

  replay             cache-only provider-preflight + full-window zero-call proof
  query-factor-fill  live query-compiler fill (API). Needs credentials.
  diagnostic         cache-only credentialless diagnostic-loop
  inspect-seed       print projection artifact inflation from a seed sqlite
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="${2:-}"; shift 2 ;;
    --offset) OFFSET="${2:-}"; shift 2 ;;
    --confirm-window) CONFIRM_WINDOW="${2:-}"; shift 2 ;;
    --work-root) WORK_ROOT="${2:-}"; shift 2 ;;
    --seed-db) SEED_DB="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag $1" ;;
  esac
done

[[ "$COMMAND" == "inspect-seed" ]] || [[ -n "$LIMIT" ]] || die "--limit is required"
if [[ "$COMMAND" != "inspect-seed" ]]; then
  [[ "$LIMIT" =~ ^[0-9]+$ ]] && [[ "$LIMIT" -gt 0 ]] || die "--limit must be a positive integer"
  if [[ "$LIMIT" -gt "$SMALL_WINDOW_CEILING" && "$CONFIRM_WINDOW" != "$LIMIT" ]]; then
    die "refusing limit=$LIMIT (>$SMALL_WINDOW_CEILING) without --confirm-window $LIMIT"
  fi
fi

ENV_FILE="${ALAYA_RECALL_ANY5_ENV:-$DEFAULT_ENV}"
[[ -f "$ENV_FILE" ]] || die "env file missing: $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

CACHE_ROOT="${ALAYA_BENCH_EXTRACTION_CACHE_ROOT:-}"
[[ -n "$CACHE_ROOT" ]] || die "ALAYA_BENCH_EXTRACTION_CACHE_ROOT unset after sourcing env"
G2="$(cd "$(dirname "$CACHE_ROOT")" && pwd)"
IDENTITY_FILE="${ALAYA_RECALL_ANY5_IDENTITY:-$G2/diagnostic-identity.json}"
MANIFEST="$CACHE_ROOT/manifest.json"

load_identity() {
  [[ -f "$MANIFEST" ]] || die "cache manifest missing: $MANIFEST"
  [[ -f "$IDENTITY_FILE" ]] || die "identity sidecar missing: $IDENTITY_FILE (write schema/operator/requested key once)"
  python3 - "$MANIFEST" "$IDENTITY_FILE" <<'PY'
import json, sys
manifest = json.loads(open(sys.argv[1], encoding="utf-8").read())
identity = json.loads(open(sys.argv[2], encoding="utf-8").read())
required = (
    "dataset_revision", "extraction_model", "request_profile",
    "system_prompt_sha256", "provider_url"
)
missing = [key for key in required if not manifest.get(key)]
if missing:
    raise SystemExit(f"manifest missing {missing}")
for key in ("schema_digest", "operator_digest", "requested_key"):
    if not identity.get(key):
        raise SystemExit(f"identity sidecar missing {key}")
print(manifest["dataset_revision"])
print(manifest["extraction_model"])
print(manifest["request_profile"])
print(manifest["system_prompt_sha256"])
print(manifest["provider_url"])
print(identity["schema_digest"])
print(identity["operator_digest"])
print(identity["requested_key"])
PY
}

run_replay() {
  local dataset model profile prompt schema operator key
  { read -r dataset; read -r model; read -r profile; read -r prompt
    read -r provider; read -r schema; read -r operator; read -r key
  } < <(load_identity)
  echo "replay identity model=$model profile=$profile limit=$LIMIT offset=$OFFSET"
  rtk node "$BIN" provider-preflight --mode replay \
    --model "$model" --request-profile "$profile"
  local keys_file
  keys_file="$(mktemp)"
  printf '%s\n' "$key" > "$keys_file"
  rtk node "$SCRIPT_DIR/prove-cache-only-replay.mjs" \
    "$keys_file" \
    "$dataset" "$prompt" "$schema" "$operator" "$CACHE_ROOT" \
    "$LIMIT" "$OFFSET" "$provider" "$model" "$profile"
  rm -f "$keys_file"
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
  rtk node "$SCRIPT_DIR/fill-query-factors.mjs" "$questions" "$out"
}

run_diagnostic() {
  local dataset model profile prompt schema operator key
  { read -r dataset; read -r model; read -r profile; read -r prompt
    read -r provider; read -r schema; read -r operator; read -r key
  } < <(load_identity)
  local work="${WORK_ROOT:-$G2/diagnostic-${LIMIT}q-run}"
  local qcache="$G2/query-factor-cache-${LIMIT}q.json"
  # Sealed 100Q query cache is a superset; small windows may reuse it.
  if [[ ! -f "$qcache" && -f "$G2/query-factor-cache-100q.json" ]]; then
    qcache="$G2/query-factor-cache-100q.json"
  fi
  mkdir -p "$work/history"
  # post-fill stages must stay credentialless
  unset ALAYA_OFFICIAL_GARDEN_SECRET_REF
  unset ALAYA_OFFICIAL_GARDEN_API_KEY
  unset OFFICIAL_API_GARDEN_API_KEY
  unset ALAYA_QA_API_KEY
  export ALAYA_BENCH_ALLOW_LIVE_EXTRACTION=0
  export ALAYA_GARDEN_PROVIDER_KIND=local_heuristics
  local extra=()
  if [[ -f "$qcache" ]]; then
    extra+=(--query-semantic-factor-cache "$qcache")
  fi
  echo "diagnostic cache-only credentialless limit=$LIMIT work=$work"
  rtk node "$BIN" diagnostic-loop \
    --work-root "$work" \
    --dataset-revision "$dataset" \
    --requested-keys "$key" \
    --provider-route "$provider" \
    --model "$model" \
    --request-profile "$profile" \
    --prompt-digest "$prompt" \
    --schema-digest "$schema" \
    --operator-digest "$operator" \
    --mode cache-only \
    --variant s --limit "$LIMIT" --offset "$OFFSET" \
    --extraction-cache-root "$CACHE_ROOT" \
    --snapshot-out "$work/snapshot.db" \
    --history-root "$work/history" \
    "${extra[@]}"
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
