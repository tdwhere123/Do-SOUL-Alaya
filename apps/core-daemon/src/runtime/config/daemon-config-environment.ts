import { resolveCoreConfigEnvironmentKeys } from "@do-soul/alaya-core";

export const DAEMON_ONLY_CONFIG_ENV_KEYS = Object.freeze({
  recall: Object.freeze({
    sourceRefRobust: "ALAYA_RECALL_SOURCE_REF_ROBUST"
  }),
  embedding: Object.freeze({
    provider: "ALAYA_EMBEDDING_PROVIDER",
    supplement: "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
    openaiSecretRef: "ALAYA_OPENAI_SECRET_REF",
    openaiModel: "OPENAI_EMBEDDING_MODEL",
    openaiProviderUrl: "OPENAI_EMBEDDING_PROVIDER_URL",
    localCacheDir: "ALAYA_LOCAL_EMBEDDING_CACHE_DIR",
    localModel: "ALAYA_LOCAL_EMBEDDING_MODEL",
    d2q: "ALAYA_RECALL_D2Q",
    localCrossEncoderRerank: "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  }),
  mcp: Object.freeze({
    toolTimeoutMs: "ALAYA_MCP_TOOL_TIMEOUT_MS",
    serverConfigJson: "ALAYA_MCP_SERVER_CONFIG_JSON",
    toolConfirmationToken: "ALAYA_MCP_TOOL_CONFIRMATION_TOKEN"
  }),
  materialization: Object.freeze({
    retainUnroutedFacts: "ALAYA_RETAIN_UNROUTED_FACTS",
    evidenceFullTurn: "ALAYA_EVIDENCE_FULL_TURN",
    confFloor: "ALAYA_MATERIALIZATION_CONF_FLOOR",
    pathrelCounterTtlMs: "ALAYA_PATHREL_COUNTER_TTL_MS"
  }),
  gardenLlm: Object.freeze({
    conflictApiKey: "ALAYA_CONFLICT_LLM_API_KEY",
    conflictModel: "ALAYA_CONFLICT_LLM_MODEL",
    conflictProviderUrl: "ALAYA_CONFLICT_LLM_PROVIDER_URL",
    conflictTimeoutMs: "ALAYA_CONFLICT_LLM_TIMEOUT_MS",
    officialSecretRef: "ALAYA_OFFICIAL_GARDEN_SECRET_REF",
    edgeProducerLlmEnabled: "ALAYA_EDGE_PRODUCER_LLM_ENABLED",
    edgeClassifyHostWorker: "ALAYA_EDGE_CLASSIFY_HOST_WORKER",
    conflictDetectionEnabled: "ALAYA_CONFLICT_DETECTION_ENABLED",
    conflictRuleEnabled: "ALAYA_CONFLICT_RULE_ENABLED",
    ingestReconciliationEnabled: "ALAYA_INGEST_RECONCILIATION_ENABLED"
  }),
  lifecycle: Object.freeze({
    port: "PORT",
    daemonHost: "DAEMON_HOST",
    allowedOrigin: "ALLOWED_ORIGIN",
    requestToken: "ALAYA_REQUEST_TOKEN",
    allowRemoteDaemon: "ALAYA_ALLOW_REMOTE_DAEMON",
    logLevel: "ALAYA_LOG_LEVEL",
    logLevelAlias: "LOG_LEVEL",
    nodeEnv: "NODE_ENV",
    principalRuntime: "ALAYA_PRINCIPAL_RUNTIME",
    zeroDayPoliciesJson: "ZERO_DAY_POLICIES_JSON",
    orphanDetectionEnabled: "ORPHAN_DETECTION_ENABLED"
  }),
  toolRuntime: Object.freeze({
    repoRoots: "ALAYA_REPO_ROOTS",
    recallReadWorkerRequestTimeoutMs: "ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS"
  }),
  reviewer: Object.freeze({
    token: "ALAYA_REVIEWER_TOKEN",
    identity: "ALAYA_REVIEWER_IDENTITY"
  })
} as const);

const DAEMON_ONLY_KEY_LIST: readonly string[] = Object.freeze(
  Object.values(DAEMON_ONLY_CONFIG_ENV_KEYS).flatMap((group) => Object.values(group))
);

export function listRegisteredDaemonEnvKeys(): readonly string[] {
  return Object.freeze([
    ...new Set([...resolveCoreConfigEnvironmentKeys(), ...DAEMON_ONLY_KEY_LIST])
  ].sort());
}

export function readDaemonProcessEnv(
  key: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  return env[key];
}
