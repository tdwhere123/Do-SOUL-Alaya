type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export const CORE_CONFIG_ENV_KEYS = Object.freeze({
  recall: Object.freeze({
    facetSlice: "ALAYA_RECALL_FACET_SLICE",
    confRhoPath: "ALAYA_RECALL_CONF_RHO_PATH",
    confRhoEvidence: "ALAYA_RECALL_CONF_RHO_EVIDENCE",
    confWPath: "ALAYA_RECALL_CONF_W_PATH",
    confEvidenceBeta: "ALAYA_RECALL_CONF_EVIDENCE_BETA",
    confFloodCap: "ALAYA_RECALL_CONF_FLOOD_CAP",
    confFloodCapTotal: "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL",
    confSliceCompatibility: "ALAYA_RECALL_CONF_SLICE_COMPATIBILITY",
    pathEmbModulation: "ALAYA_RECALL_PATH_EMB_MODULATION",
    projections: "ALAYA_RECALL_PROJECTIONS",
    lexicalDecorr: "ALAYA_RECALL_LEXICAL_DECORR",
    intentV2: "ALAYA_RECALL_INTENT_V2",
    extraSynonymClusters: "ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS",
    sessionRoute: "ALAYA_RECALL_SESSION_ROUTE",
    finalAuthorityMaxHeadDrop: "ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP"
  }),
  embedding: Object.freeze({
    backfillConcurrency: "ALAYA_EMBEDDING_BACKFILL_CONCURRENCY",
    recallTiers: "ALAYA_EMBEDDING_RECALL_TIERS",
    workspaceScanCap: "ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP"
  }),
  pathGraph: Object.freeze({
    contentStrength: "ALAYA_PATHREL_CONTENT_STRENGTH"
  })
} as const);

export const CORE_CONFIG_ENV_PREFIXES = Object.freeze({
  recallSemantic: "ALAYA_RECALL_SEMANTIC_"
} as const);

const EXACT_KEYS = Object.freeze([
  ...Object.values(CORE_CONFIG_ENV_KEYS.recall),
  ...Object.values(CORE_CONFIG_ENV_KEYS.embedding),
  ...Object.values(CORE_CONFIG_ENV_KEYS.pathGraph)
]);
const EXACT_KEY_SET: ReadonlySet<string> = new Set(EXACT_KEYS);
const PREFIXES = Object.freeze(Object.values(CORE_CONFIG_ENV_PREFIXES));

export function isCoreConfigEnvironmentKey(name: string): boolean {
  return EXACT_KEY_SET.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function resolveCoreConfigEnvironmentKeys(
  ...environments: readonly ConfigEnvironment[]
): readonly string[] {
  const keys = new Set<string>(EXACT_KEYS);
  for (const environment of environments) {
    for (const name of Object.keys(environment)) {
      if (isCoreConfigEnvironmentKey(name)) keys.add(name);
    }
  }
  return Object.freeze([...keys].sort());
}
