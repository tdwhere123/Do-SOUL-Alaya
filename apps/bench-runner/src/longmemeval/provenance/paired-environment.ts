import { createHash } from "node:crypto";

export type CredentialStateMarker = "unset" | "empty" | "configured";

export function resolveCredentialStateMarker(
  value: string | undefined
): CredentialStateMarker {
  if (value === undefined) return "unset";
  return value.trim().length === 0 ? "empty" : "configured";
}

const PAIRED_ENV_ALLOWLIST = new Set([
  "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION",
  "ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE",
  "ALAYA_BENCH_EXTRACTION_MODEL_FAMILY",
  "ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL",
  "ALAYA_BENCH_EXTRACTION_TRANSPORT_PROVIDER_URL",
  "ALAYA_BENCH_RUN_EDGE_PLANE",
  "ALAYA_CONFLICT_DETECTION_ENABLED",
  "ALAYA_CONFLICT_LLM_PROVIDER_URL",
  "ALAYA_CONFLICT_RULE_ENABLED",
  "ALAYA_EMBEDDING_PROVIDER",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_ENABLE_GARDEN_OFFICIAL",
  "ALAYA_EDGE_CLASSIFY_HOST_WORKER",
  "ALAYA_EDGE_PRODUCER_LLM_ENABLED",
  "ALAYA_EVIDENCE_FULL_TURN",
  "ALAYA_EXP_ANSWERS_WITH_BAR",
  "ALAYA_EXP_ANSWERS_WITH_CAP",
  "ALAYA_EXP_ANSWERS_WITH_XSESSION",
  "ALAYA_EXP_COHERENCE_CAP",
  "ALAYA_EXP_COHERENCE_EDGES",
  "ALAYA_EXP_COHERENCE_FLOOR",
  "ALAYA_EXP_COHERENCE_XSESSION",
  "ALAYA_GARDEN_PROVIDER_KIND",
  "ALAYA_INGEST_RECONCILIATION_ENABLED",
  "ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT",
  "ALAYA_LOCAL_ONNX_THREADS",
  "ALAYA_LOCAL_EMBEDDING_MODEL",
  "ALAYA_MATERIALIZATION_CONF_FLOOR",
  "ALAYA_PATHREL_COUNTER_TTL_MS",
  "ALAYA_PATHREL_CO_USAGE_THRESHOLD",
  "ALAYA_RECALL_ANSWERS_WITH",
  "ALAYA_RECALL_COARSE_FLOOR",
  "ALAYA_RECALL_CONF_FLOOD_CAP",
  "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL",
  "ALAYA_RECALL_CONF_RHO_EVIDENCE",
  "ALAYA_RECALL_CONF_RHO_PATH",
  "ALAYA_RECALL_CONF_W_PATH",
  "ALAYA_RECALL_D2Q",
  "ALAYA_RECALL_EVAL_EMBEDDING",
  "ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP",
  "ALAYA_RECALL_SOURCE_REF_ROBUST",
  "ALAYA_RETAIN_UNROUTED_FACTS",
  "OFFICIAL_API_GARDEN_MODEL",
  "OFFICIAL_API_GARDEN_PROVIDER_URL"
]);

export function collectPairedEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  const entries: [string, string][] = Object.entries(env)
    .filter(([key, value]) => value !== undefined && PAIRED_ENV_ALLOWLIST.has(key))
    .map(([key, value]) => [key, redactProvenanceUrl(value!)] as [string, string]);

  // Raw credential values cannot enter provenance; markers remain launch diagnostics only.
  entries.push([
    "ALAYA_OFFICIAL_GARDEN_SECRET_REF_STATE",
    resolveCredentialStateMarker(env.ALAYA_OFFICIAL_GARDEN_SECRET_REF)
  ]);
  entries.push([
    "ALAYA_OFFICIAL_GARDEN_API_KEY_STATE",
    resolveCredentialStateMarker(env.ALAYA_OFFICIAL_GARDEN_API_KEY)
  ]);

  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

export function redactProvenanceUrl(value: string): string {
  if (!/(?:https?|wss?):\/\//iu.test(value)) return value;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
