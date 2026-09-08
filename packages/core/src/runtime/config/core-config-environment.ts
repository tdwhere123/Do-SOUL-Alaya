type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export const CORE_CONFIG_ENV_KEYS = Object.freeze({
  recall: Object.freeze({
    projections: "ALAYA_RECALL_PROJECTIONS",
    extraSynonymClusters: "ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS"
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

const EXACT_KEYS = Object.freeze([
  ...Object.values(CORE_CONFIG_ENV_KEYS.recall),
  ...Object.values(CORE_CONFIG_ENV_KEYS.embedding),
  ...Object.values(CORE_CONFIG_ENV_KEYS.pathGraph)
]);
const EXACT_KEY_SET: ReadonlySet<string> = new Set(EXACT_KEYS);

export function isCoreConfigEnvironmentKey(name: string): boolean {
  return EXACT_KEY_SET.has(name);
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
