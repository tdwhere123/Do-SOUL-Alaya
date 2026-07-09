export interface RecallRuntimeConfig {
  readonly compose: boolean;
  readonly embedPoolRescore: boolean;
  readonly s4Coverage: string | undefined;
  readonly coverageSelector: string | undefined;
  readonly coveragePoolK: number | undefined;
  readonly coverageTargetK: number | undefined;
  readonly coverageMinScoreRatio: number | undefined;
  readonly sessionCoverageBand: string | undefined;
  readonly facetOverlap: string | undefined;
  readonly facetSlice: string | undefined;
  readonly confRhoPath: number | undefined;
  readonly confRhoEvidence: number | undefined;
  readonly confWPath: number | undefined;
  readonly confEvidenceBeta: number | undefined;
  readonly confFloodCap: number | undefined;
  readonly confFloodCapTotal: number | undefined;
  readonly pathEmbModulation: string | undefined;
  readonly structuralReserve: string | undefined;
  /** Refuse delivery stages that hard-evict fusion rank ≤K. Default off. */
  readonly fusionRankFloor: string | undefined;
  readonly projectionsEnabled: boolean;
  readonly temporalWindowEnabled: boolean;
  readonly lexicalDecorr: string | undefined;
  readonly deliverFusedOrder: string | undefined;
  readonly deliveryWindow: number | undefined;
  readonly intentV2: boolean;
  readonly queryHydeJson: string | undefined;
  readonly queryFacetsJson: string | undefined;
  readonly extraSynonymClusters: string | undefined;
  readonly nowIso: string | undefined;
  readonly sessionRoute: boolean;
  readonly coarseFilterSemanticFlags: Readonly<Record<string, string | undefined>>;
  readonly activationAssemblyFlags: Readonly<Record<string, string | undefined>>;
}

function flagEnabled(raw: string | undefined): boolean {
  return raw === "on" || raw === "1" || raw === "true";
}

function optOutDisabled(raw: string | undefined): boolean {
  return raw === "off" || raw === "0" || raw === "false";
}

function defaultOn(raw: string | undefined): boolean {
  return !/^(?:0|false|off|no)$/iu.test(raw ?? "on");
}

function yesEnabled(raw: string | undefined): boolean {
  return /^(?:1|true|on|yes)$/iu.test(raw ?? "");
}

function readOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function collectPrefixedEnv(
  env: Readonly<Record<string, string | undefined>>,
  prefix: string
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix)) {
      out[key] = value;
    }
  }
  return Object.freeze(out);
}

export function parseRecallRuntimeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>
): RecallRuntimeConfig {
  return Object.freeze({
    compose: flagEnabled(env.ALAYA_RECALL_COMPOSE),
    embedPoolRescore: !optOutDisabled(env.ALAYA_RECALL_EMBED_POOL_RESCORE),
    s4Coverage: env.ALAYA_RECALL_S4_COVERAGE,
    coverageSelector: env.ALAYA_RECALL_COVERAGE_SELECTOR,
    coveragePoolK: readOptionalNumber(env.ALAYA_RECALL_COVERAGE_POOL_K),
    coverageTargetK: readOptionalNumber(env.ALAYA_RECALL_COVERAGE_TARGET_K),
    coverageMinScoreRatio: readOptionalNumber(env.ALAYA_RECALL_COVERAGE_MIN_SCORE_RATIO),
    sessionCoverageBand: env.ALAYA_RECALL_SESSION_COVERAGE_BAND,
    facetOverlap: env.ALAYA_RECALL_FACET_OVERLAP,
    facetSlice: env.ALAYA_RECALL_FACET_SLICE,
    confRhoPath: readOptionalNumber(env.ALAYA_RECALL_CONF_RHO_PATH),
    confRhoEvidence: readOptionalNumber(env.ALAYA_RECALL_CONF_RHO_EVIDENCE),
    confWPath: readOptionalNumber(env.ALAYA_RECALL_CONF_W_PATH),
    confEvidenceBeta: readOptionalNumber(env.ALAYA_RECALL_CONF_EVIDENCE_BETA),
    confFloodCap: readOptionalNumber(env.ALAYA_RECALL_CONF_FLOOD_CAP),
    confFloodCapTotal: readOptionalNumber(env.ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL),
    pathEmbModulation: env.ALAYA_RECALL_PATH_EMB_MODULATION,
    structuralReserve: env.ALAYA_RECALL_STRUCTURAL_RESERVE,
    fusionRankFloor: env.ALAYA_RECALL_FUSION_RANK_FLOOR,
    projectionsEnabled: defaultOn(env.ALAYA_RECALL_PROJECTIONS),
    temporalWindowEnabled: yesEnabled(env.ALAYA_RECALL_TEMPORAL_WINDOW),
    lexicalDecorr: env.ALAYA_RECALL_LEXICAL_DECORR,
    deliverFusedOrder: env.ALAYA_RECALL_DELIVER_FUSED_ORDER,
    deliveryWindow: readOptionalNumber(env.ALAYA_RECALL_DELIVERY_WINDOW),
    intentV2: /^(?:1|true|on|yes)$/iu.test(env.ALAYA_RECALL_INTENT_V2 ?? ""),
    queryHydeJson: env.ALAYA_RECALL_QUERY_HYDE_JSON,
    queryFacetsJson: env.ALAYA_RECALL_QUERY_FACETS_JSON,
    extraSynonymClusters: env.ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS,
    nowIso: env.ALAYA_RECALL_NOW_ISO,
    sessionRoute: yesEnabled(env.ALAYA_RECALL_SESSION_ROUTE),
    coarseFilterSemanticFlags: collectPrefixedEnv(env, "ALAYA_RECALL_SEMANTIC_"),
    activationAssemblyFlags: collectPrefixedEnv(env, "ALAYA_RECALL_COMPOSE_")
  });
}
