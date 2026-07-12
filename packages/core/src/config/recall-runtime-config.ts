export interface RecallRuntimeConfig {
  readonly embedPoolRescore: boolean;
  readonly facetSlice: string | undefined;
  readonly confRhoPath: number | undefined;
  readonly confRhoEvidence: number | undefined;
  readonly confWPath: number | undefined;
  readonly confEvidenceBeta: number | undefined;
  readonly confFloodCap: number | undefined;
  readonly confFloodCapTotal: number | undefined;
  readonly confSliceCompatibility: boolean;
  readonly pathEmbModulation: string | undefined;
  readonly projectionsEnabled: boolean;
  readonly lexicalDecorr: string | undefined;
  readonly intentV2: boolean;
  readonly queryHydeJson: string | undefined;
  readonly extraSynonymClusters: string | undefined;
  readonly sessionRoute: boolean;
  readonly coarseFilterSemanticFlags: Readonly<Record<string, string | undefined>>;
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
    embedPoolRescore: !optOutDisabled(env.ALAYA_RECALL_EMBED_POOL_RESCORE),
    facetSlice: env.ALAYA_RECALL_FACET_SLICE,
    confRhoPath: readOptionalNumber(env.ALAYA_RECALL_CONF_RHO_PATH),
    confRhoEvidence: readOptionalNumber(env.ALAYA_RECALL_CONF_RHO_EVIDENCE),
    confWPath: readOptionalNumber(env.ALAYA_RECALL_CONF_W_PATH),
    confEvidenceBeta: readOptionalNumber(env.ALAYA_RECALL_CONF_EVIDENCE_BETA),
    confFloodCap: readOptionalNumber(env.ALAYA_RECALL_CONF_FLOOD_CAP),
    confFloodCapTotal: readOptionalNumber(env.ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL),
    confSliceCompatibility: flagEnabled(env.ALAYA_RECALL_CONF_SLICE_COMPATIBILITY),
    pathEmbModulation: env.ALAYA_RECALL_PATH_EMB_MODULATION,
    projectionsEnabled: defaultOn(env.ALAYA_RECALL_PROJECTIONS),
    lexicalDecorr: env.ALAYA_RECALL_LEXICAL_DECORR,
    intentV2: /^(?:1|true|on|yes)$/iu.test(env.ALAYA_RECALL_INTENT_V2 ?? ""),
    queryHydeJson: env.ALAYA_RECALL_QUERY_HYDE_JSON,
    extraSynonymClusters: env.ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS,
    sessionRoute: yesEnabled(env.ALAYA_RECALL_SESSION_ROUTE),
    coarseFilterSemanticFlags: collectPrefixedEnv(env, "ALAYA_RECALL_SEMANTIC_")
  });
}
