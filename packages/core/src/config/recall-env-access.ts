import { getCoreConfig } from "./install-core-config.js";

export function recallEnvRaw(name: string): string | undefined {
  const recall = getCoreConfig().recall;
  switch (name) {
    case "ALAYA_RECALL_COMPOSE":
      return recall.compose ? "on" : undefined;
    case "ALAYA_RECALL_EMBED_POOL_RESCORE":
      return recall.embedPoolRescore ? "on" : "off";
    case "ALAYA_RECALL_S4_COVERAGE":
      return recall.s4Coverage;
    case "ALAYA_RECALL_COVERAGE_SELECTOR":
      return recall.coverageSelector;
    case "ALAYA_RECALL_COVERAGE_POOL_K":
      return recall.coveragePoolK === undefined ? undefined : String(recall.coveragePoolK);
    case "ALAYA_RECALL_COVERAGE_TARGET_K":
      return recall.coverageTargetK === undefined ? undefined : String(recall.coverageTargetK);
    case "ALAYA_RECALL_COVERAGE_MIN_SCORE_RATIO":
      return recall.coverageMinScoreRatio === undefined ? undefined : String(recall.coverageMinScoreRatio);
    case "ALAYA_RECALL_SESSION_COVERAGE_BAND":
      return recall.sessionCoverageBand;
    case "ALAYA_RECALL_FACET_OVERLAP":
      return recall.facetOverlap;
    case "ALAYA_RECALL_FACET_SLICE":
      return recall.facetSlice;
    case "ALAYA_RECALL_CONF_RHO_PATH":
      return recall.confRhoPath === undefined ? undefined : String(recall.confRhoPath);
    case "ALAYA_RECALL_CONF_RHO_EVIDENCE":
      return recall.confRhoEvidence === undefined ? undefined : String(recall.confRhoEvidence);
    case "ALAYA_RECALL_CONF_W_PATH":
      return recall.confWPath === undefined ? undefined : String(recall.confWPath);
    case "ALAYA_RECALL_CONF_EVIDENCE_BETA":
      return recall.confEvidenceBeta === undefined ? undefined : String(recall.confEvidenceBeta);
    case "ALAYA_RECALL_CONF_FLOOD_CAP":
      return recall.confFloodCap === undefined ? undefined : String(recall.confFloodCap);
    case "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL":
      return recall.confFloodCapTotal === undefined ? undefined : String(recall.confFloodCapTotal);
    case "ALAYA_RECALL_PATH_EMB_MODULATION":
      return recall.pathEmbModulation;
    case "ALAYA_RECALL_STRUCTURAL_RESERVE":
      return recall.structuralReserve;
    case "ALAYA_RECALL_FUSION_RANK_FLOOR":
      return recall.fusionRankFloor;
    case "ALAYA_RECALL_PROJECTIONS":
      return recall.projectionsEnabled ? "on" : "off";
    case "ALAYA_RECALL_TEMPORAL_WINDOW":
      return recall.temporalWindowEnabled ? "on" : undefined;
    case "ALAYA_RECALL_LEXICAL_DECORR":
      return recall.lexicalDecorr;
    case "ALAYA_RECALL_DELIVER_FUSED_ORDER":
      return recall.deliverFusedOrder;
    case "ALAYA_RECALL_DELIVERY_WINDOW":
      return recall.deliveryWindow === undefined ? undefined : String(recall.deliveryWindow);
    case "ALAYA_RECALL_INTENT_V2":
      return recall.intentV2 ? "on" : undefined;
    case "ALAYA_RECALL_QUERY_HYDE_JSON":
      return recall.queryHydeJson;
    case "ALAYA_RECALL_QUERY_FACETS_JSON":
      return recall.queryFacetsJson;
    case "ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS":
      return recall.extraSynonymClusters;
    case "ALAYA_RECALL_NOW_ISO":
      return recall.nowIso;
    case "ALAYA_RECALL_SESSION_ROUTE":
      return recall.sessionRoute ? "on" : undefined;
    default:
      return recall.coarseFilterSemanticFlags[name] ?? recall.activationAssemblyFlags[name];
  }
}

export function recallEnvFlagEnabled(name: string): boolean {
  const raw = recallEnvRaw(name);
  return raw === "on" || raw === "1" || raw === "true";
}

export function recallProjectionScoringEnabled(): boolean {
  return getCoreConfig().recall.projectionsEnabled;
}

export function recallTemporalWindowEnabled(): boolean {
  return getCoreConfig().recall.temporalWindowEnabled;
}

export function recallIntentV2Enabled(): boolean {
  return getCoreConfig().recall.intentV2;
}

export function recallSessionRouteEnabled(): boolean {
  return getCoreConfig().recall.sessionRoute;
}

export function recallEmbedPoolRescoreEnabled(): boolean {
  return getCoreConfig().recall.embedPoolRescore;
}

export function recallAnswersWithEnabled(): boolean {
  const recall = getCoreConfig().recall;
  return recall.answersWith || recall.expAnswersWith;
}

export function readRecallPositiveInt(name: string, fallback: number): number {
  const raw = Number(recallEnvRaw(name));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function readRecallRatio(name: string, fallback: number): number {
  const raw = Number(recallEnvRaw(name));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function readRecallUnitFloat(name: string, fallback: number): number {
  const raw = Number(recallEnvRaw(name));
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : fallback;
}

export function readRecallFloat(name: string, fallback: number, min: number): number {
  const raw = Number(recallEnvRaw(name));
  return Number.isFinite(raw) ? Math.max(min, raw) : fallback;
}
