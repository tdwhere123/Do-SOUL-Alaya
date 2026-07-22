import { getCoreConfig } from "./install-core-config.js";

type RecallConfig = ReturnType<typeof getCoreConfig>["recall"];
type RecallEnvLookup = Readonly<
  | { readonly matched: false }
  | { readonly matched: true; readonly value: string | undefined }
>;

const RECALL_ENV_NOT_MATCHED: RecallEnvLookup = Object.freeze({ matched: false });

export function recallEnvRaw(name: string): string | undefined {
  const recall = getCoreConfig().recall;
  let lookup = readRecallSelectionEnv(recall, name);
  if (lookup.matched) return lookup.value;
  lookup = readRecallFloodEnv(recall, name);
  if (lookup.matched) return lookup.value;
  lookup = readRecallDeliveryEnv(recall, name);
  if (lookup.matched) return lookup.value;
  return recall.coarseFilterSemanticFlags[name];
}

function readRecallSelectionEnv(recall: RecallConfig, name: string): RecallEnvLookup {
  switch (name) {
    case "ALAYA_RECALL_FACET_SLICE":
      return matched(recall.facetSlice);
    default:
      return RECALL_ENV_NOT_MATCHED;
  }
}

function readRecallFloodEnv(recall: RecallConfig, name: string): RecallEnvLookup {
  switch (name) {
    case "ALAYA_RECALL_CONF_RHO_PATH":
      return matched(stringify(recall.confRhoPath));
    case "ALAYA_RECALL_CONF_RHO_EVIDENCE":
      return matched(stringify(recall.confRhoEvidence));
    case "ALAYA_RECALL_CONF_W_PATH":
      return matched(stringify(recall.confWPath));
    case "ALAYA_RECALL_CONF_EVIDENCE_BETA":
      return matched(stringify(recall.confEvidenceBeta));
    case "ALAYA_RECALL_CONF_FLOOD_CAP":
      return matched(stringify(recall.confFloodCap));
    case "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL":
      return matched(stringify(recall.confFloodCapTotal));
    case "ALAYA_RECALL_CONF_SLICE_COMPATIBILITY":
      return matched(recall.confSliceCompatibility ? "on" : undefined);
    case "ALAYA_RECALL_PATH_EMB_MODULATION":
      return matched(recall.pathEmbModulation);
    default:
      return RECALL_ENV_NOT_MATCHED;
  }
}

function readRecallDeliveryEnv(recall: RecallConfig, name: string): RecallEnvLookup {
  switch (name) {
    case "ALAYA_RECALL_PROJECTIONS":
      return matched(recall.projectionsEnabled ? "on" : "off");
    case "ALAYA_RECALL_LEXICAL_DECORR":
      return matched(recall.lexicalDecorr);
    case "ALAYA_RECALL_INTENT_V2":
      return matched(recall.intentV2 ? "on" : undefined);
    case "ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS":
      return matched(recall.extraSynonymClusters);
    case "ALAYA_RECALL_SESSION_ROUTE":
      return matched(recall.sessionRoute ? "on" : undefined);
    case "ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP":
      return matched(stringify(recall.finalAuthorityMaxHeadDrop));
    default:
      return RECALL_ENV_NOT_MATCHED;
  }
}

function matched(value: string | undefined): RecallEnvLookup {
  return Object.freeze({ matched: true, value });
}

function stringify(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function recallEnvFlagEnabled(name: string): boolean {
  const raw = recallEnvRaw(name);
  return raw === "on" || raw === "1" || raw === "true";
}

export function recallProjectionScoringEnabled(): boolean {
  return getCoreConfig().recall.projectionsEnabled;
}

export function recallIntentV2Enabled(): boolean {
  return getCoreConfig().recall.intentV2;
}

export function recallSessionRouteEnabled(): boolean {
  return getCoreConfig().recall.sessionRoute;
}

export function recallFinalAuthorityMaxHeadDrop(): number | undefined {
  return getCoreConfig().recall.finalAuthorityMaxHeadDrop;
}

/** answers_with / flood path fuel is always on; no closable off-switch. */
export function recallAnswersWithEnabled(): boolean {
  return true;
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
