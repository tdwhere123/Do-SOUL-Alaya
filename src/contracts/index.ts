export const CONTRACT_SCHEMA_VERSION = "soul-memory.contracts.v1" as const;
export const EXPORT_BUNDLE_SCHEMA_VERSION = "soul-memory.bundle.v1" as const;

export const MEMORY_PLANES = [
  "global-personal",
  "project-local",
  "shared-cloud-team"
] as const;
export type MemoryPlane = (typeof MEMORY_PLANES)[number];

export const DAY_ONE_MEMORY_PLANES = ["global-personal", "project-local"] as const;
export type DayOneMemoryPlane = (typeof DAY_ONE_MEMORY_PLANES)[number];

export const SCOPE_KINDS = [
  "global",
  "project",
  "workspace",
  "repo",
  "path",
  "task",
  "session"
] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const SOURCE_TYPES = [
  "operator",
  "agent-observation",
  "run-artifact",
  "file",
  "project-context",
  "import",
  "system"
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const EVIDENCE_TYPES = [
  "operator-statement",
  "agent-observation",
  "file-excerpt",
  "run-artifact",
  "external-reference",
  "import-record"
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const MEMORY_KINDS = [
  "preference",
  "decision",
  "constraint",
  "fact",
  "procedure",
  "hazard",
  "lesson",
  "relationship"
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_DURABILITIES = ["draft", "durable"] as const;
export type MemoryDurability = (typeof MEMORY_DURABILITIES)[number];

export const MEMORY_LIFECYCLES = [
  "candidate",
  "accepted",
  "rejected",
  "retired",
  "superseded",
  "sensitive"
] as const;
export type MemoryLifecycle = (typeof MEMORY_LIFECYCLES)[number];

export const USAGE_RECOMMENDATIONS = ["blocking", "advisory", "historical"] as const;
export type UsageRecommendation = (typeof USAGE_RECOMMENDATIONS)[number];

export const SESSION_MODES = ["connect", "attach", "gateway"] as const;
export type MemorySessionMode = (typeof SESSION_MODES)[number];

export const SESSION_USAGE_STATES = [
  "not-delivered",
  "delivered",
  "used",
  "skipped",
  "unverifiable",
  "mixed"
] as const;
export type MemorySessionUsageState = (typeof SESSION_USAGE_STATES)[number];

export const INGEST_STATES = [
  "not-requested",
  "requested",
  "previewed",
  "accepted",
  "rejected",
  "skipped",
  "failed"
] as const;
export type MemoryIngestState = (typeof INGEST_STATES)[number];

export const USAGE_EVENT_KINDS = [
  "context-pack-assembled",
  "context-pack-attached",
  "recall-item-delivered",
  "recall-item-cited",
  "recall-item-contradicted",
  "recall-item-skipped",
  "memory-tool-called",
  "usage-proof-unavailable"
] as const;
export type MemoryUsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

export const INGEST_EVENT_KINDS = [
  "ingest-requested",
  "ingest-previewed",
  "memory-accepted",
  "memory-rejected",
  "ingest-skipped",
  "ingest-failed",
  "no-durable-memory-created"
] as const;
export type MemoryIngestEventKind = (typeof INGEST_EVENT_KINDS)[number];

export const VIOLATION_KINDS = [
  "required-pre-recall-skipped",
  "context-pack-not-attached",
  "required-post-run-ingest-skipped",
  "rejected-memory-recalled",
  "project-memory-bypassed",
  "stale-memory-used-without-warning",
  "durable-memory-missing-evidence"
] as const;
export type AgentContractViolationKind = (typeof VIOLATION_KINDS)[number];

export const AUDIT_EVENT_KINDS = [
  "memory.created",
  "memory.accepted",
  "memory.rejected",
  "memory.retired",
  "memory.sensitive_marked",
  "memory.conflict_resolved",
  "memory.strength_adjusted",
  "memory.scope_moved",
  "recall.performed",
  "context_pack.assembled",
  "session.started",
  "session.finished",
  "bundle.imported",
  "bundle.exported"
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MemoryId = string;
export type EvidenceId = string;
export type ScopeId = string;
export type SourceId = string;
export type ContextPackId = string;
export type MemorySessionId = string;
export type AuditEventId = string;
export type RecallCandidateId = string;
export type IsoDateString = string;

export interface SourceRef {
  id: SourceId;
  type: SourceType;
  ref: string;
  actor?: string;
  observedAt?: IsoDateString;
}

export interface EvidenceRef {
  evidenceId: EvidenceId;
  sourceId?: SourceId;
  note?: string;
}

export interface Scope {
  id: ScopeId;
  plane: MemoryPlane;
  kind: ScopeKind;
  name: string;
  identity: string;
  parentId?: ScopeId;
  path?: string;
  metadata?: Record<string, JsonValue>;
}

export interface Evidence {
  id: EvidenceId;
  type: EvidenceType;
  source: SourceRef;
  summary: string;
  payload?: JsonValue;
  pointer?: string;
  createdAt: IsoDateString;
  confidence?: number;
}

export interface MemoryContent {
  summary: string;
  body?: string;
  language?: string;
}

export interface MemoryFacet {
  key: string;
  value: string;
  confidence?: number;
}

export interface SensitivityPolicy {
  level: "none" | "private" | "sensitive" | "secret";
  reason?: string;
  retention?: "normal" | "redact-on-export" | "do-not-export";
}

export interface MemoryObject {
  id: MemoryId;
  plane: MemoryPlane;
  scopeId: ScopeId;
  kind: MemoryKind;
  durability: MemoryDurability;
  lifecycle: MemoryLifecycle;
  content: MemoryContent;
  facets: MemoryFacet[];
  source: SourceRef | null;
  evidenceIds: EvidenceId[];
  confidence: number;
  strength: number;
  createdAt: IsoDateString;
  updatedAt?: IsoDateString;
  tags?: string[];
  supersedes?: MemoryId[];
  sensitivity?: SensitivityPolicy;
}

export type GlobalMemoryObject = MemoryObject & {
  plane: "global-personal";
};

export type ProjectMemoryObject = MemoryObject & {
  plane: "project-local";
};

export interface RecallCandidateFlags {
  stale?: boolean;
  sensitive?: boolean;
  conflicted?: boolean;
  superseded?: boolean;
}

export interface RecallCandidate {
  id: RecallCandidateId;
  memoryId: MemoryId;
  plane: MemoryPlane;
  rank: number;
  score: number;
  reason: string;
  recommendedUse: UsageRecommendation;
  evidenceRefs: EvidenceRef[];
  sourceRef: SourceRef;
  lifecycle: MemoryLifecycle;
  flags?: RecallCandidateFlags;
}

export interface RecallExclusion {
  id: string;
  memoryId: MemoryId;
  plane: MemoryPlane;
  reason: string;
  evidenceRefs: EvidenceRef[];
  lifecycle: MemoryLifecycle;
  conflictWithMemoryId?: MemoryId;
  supersededByMemoryId?: MemoryId;
}

export interface ContextPackEntry {
  id: string;
  memoryId: MemoryId;
  plane: MemoryPlane;
  rank: number;
  score: number;
  reason: string;
  recommendedUse: UsageRecommendation;
  evidenceRefs: EvidenceRef[];
  sourceRef: SourceRef;
  flags?: RecallCandidateFlags;
}

export interface ContextPack {
  id: ContextPackId;
  sessionId?: MemorySessionId;
  requestId?: string;
  query: string;
  planePolicy: "all-day-one" | "global-only" | "project-only" | "explicit";
  recallPolicyVersion: string;
  createdAt: IsoDateString;
  included: ContextPackEntry[];
  excluded: RecallExclusion[];
  totalIncludedCount: number;
  totalExcludedCount: number;
  explanationSummary: string;
}

export interface MemoryUsageEvent {
  id: string;
  sessionId: MemorySessionId;
  kind: MemoryUsageEventKind;
  at: IsoDateString;
  memoryId?: MemoryId;
  contextPackId?: ContextPackId;
  state: "delivered" | "used" | "skipped" | "unverifiable";
  proof?: string;
  reason?: string;
}

export interface MemoryIngestEvent {
  id: string;
  sessionId: MemorySessionId;
  kind: MemoryIngestEventKind;
  at: IsoDateString;
  memoryId?: MemoryId;
  evidenceIds?: EvidenceId[];
  state: MemoryIngestState;
  reason?: string;
}

export interface AgentContractViolation {
  id: string;
  sessionId: MemorySessionId;
  kind: AgentContractViolationKind;
  severity: "blocking" | "important" | "nice-to-have";
  at: IsoDateString;
  message: string;
  memoryId?: MemoryId;
  contextPackId?: ContextPackId;
  evidenceRefs?: EvidenceRef[];
  resolvedAt?: IsoDateString;
}

export interface MemorySession {
  id: MemorySessionId;
  agent: {
    kind: string;
    client?: string;
    version?: string;
  };
  mode: MemorySessionMode;
  host?: string;
  project?: string;
  workspace?: string;
  startedAt: IsoDateString;
  finishedAt?: IsoDateString;
  contextPackId?: ContextPackId;
  usageState: MemorySessionUsageState;
  ingestState: MemoryIngestState;
  deliveredMemoryIds: MemoryId[];
  usedMemoryIds: MemoryId[];
  skippedMemoryIds: MemoryId[];
  unverifiableMemoryIds: MemoryId[];
  violationSummary: {
    blocking: number;
    important: number;
    niceToHave: number;
  };
}

export interface AuditEvent {
  id: AuditEventId;
  type: AuditEventKind;
  at: IsoDateString;
  actor: string;
  target: {
    type: "memory" | "scope" | "evidence" | "session" | "context-pack" | "bundle";
    id: string;
  };
  reason: string;
  evidenceRefs?: EvidenceRef[];
  changes?: Record<string, JsonValue>;
}

export interface MemoryGraphNode {
  id: string;
  kind: "memory" | "scope" | "evidence" | "source" | "session" | "context-pack";
  label: string;
  plane?: MemoryPlane;
}

export interface MemoryGraphEdge {
  id: string;
  from: string;
  to: string;
  kind:
    | "contains"
    | "supported-by"
    | "derived-from"
    | "conflicts-with"
    | "supersedes"
    | "recalled-in"
    | "used-in";
  reason?: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  generatedAt: IsoDateString;
}

export interface ExportBundle {
  schemaVersion: typeof EXPORT_BUNDLE_SCHEMA_VERSION;
  exportedAt: IsoDateString;
  scopes: Scope[];
  memories: MemoryObject[];
  evidence: Evidence[];
  auditEvents: AuditEvent[];
  sessions?: MemorySession[];
  contextPacks?: ContextPack[];
  graph?: MemoryGraph;
}

export type ImportBundle = ExportBundle;
export type ImportMode = "merge" | "replace" | "preview";

export interface HealthOutput {
  ok: boolean;
  version: string;
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
}

export interface StorageStatusOutput {
  ready: boolean;
  location?: string;
  migrationsApplied?: string[];
  warnings?: string[];
}

export interface DoctorOutput {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message?: string }>;
}

export interface IngestMemoryInput {
  memory: MemoryObject;
  evidence?: Evidence[];
}

export interface PreviewIngestInput {
  memory: MemoryObject;
  evidence?: Evidence[];
}

export interface PreviewIngestOutput {
  accepted: boolean;
  reasons: string[];
  memory: MemoryObject;
}

export interface IngestMemoryOutput {
  memory: MemoryObject;
  auditEvent: AuditEvent;
}

export interface IngestEvidenceInput {
  evidence: Evidence;
  memoryId?: MemoryId;
}

export interface IngestEvidenceOutput {
  evidence: Evidence;
}

export interface RecallInput {
  query: string;
  scopeIds?: ScopeId[];
  planes?: DayOneMemoryPlane[];
  limit?: number;
}

export interface RecallOutput {
  candidates: RecallCandidate[];
  exclusions: RecallExclusion[];
  explanationSummary: string;
}

export interface AssembleContextInput {
  query: string;
  requestId?: string;
  sessionId?: MemorySessionId;
  scopeIds?: ScopeId[];
  planes?: DayOneMemoryPlane[];
  limit?: number;
}

export interface AssembleContextOutput {
  contextPack: ContextPack;
}

export interface StartMemorySessionInput {
  agent: MemorySession["agent"];
  mode: MemorySessionMode;
  host?: string;
  project?: string;
  workspace?: string;
}

export interface StartMemorySessionOutput {
  session: MemorySession;
}

export interface RecordMemoryUsageInput {
  event: MemoryUsageEvent;
}

export interface RecordMemoryUsageOutput {
  event: MemoryUsageEvent;
  session: MemorySession;
}

export interface RecordMemoryIngestInput {
  event: MemoryIngestEvent;
}

export interface RecordMemoryIngestOutput {
  event: MemoryIngestEvent;
  session: MemorySession;
}

export interface FinishMemorySessionInput {
  finishedAt: IsoDateString;
  usageState: MemorySessionUsageState;
  ingestState: MemoryIngestState;
}

export interface FinishMemorySessionOutput {
  session: MemorySession;
}

export interface ExplainRecallInput {
  candidateId: RecallCandidateId;
}

export interface ExplainRecallOutput {
  candidate: RecallCandidate;
}

export interface ListMemoriesInput {
  planes?: MemoryPlane[];
  scopeIds?: ScopeId[];
  lifecycle?: MemoryLifecycle[];
  tags?: string[];
}

export interface ListMemoriesOutput {
  memories: MemoryObject[];
}

export interface GetMemoryInput {
  memoryId: MemoryId;
}

export interface GetMemoryOutput {
  memory: MemoryObject;
}

export interface ListEvidenceInput {
  memoryId?: MemoryId;
}

export interface ListEvidenceOutput {
  evidence: Evidence[];
}

export interface ListScopesInput {
  planes?: MemoryPlane[];
  kinds?: ScopeKind[];
}

export interface ListScopesOutput {
  scopes: Scope[];
}

export interface ListAuditEventsInput {
  targetId?: string;
  types?: AuditEventKind[];
  since?: IsoDateString;
  until?: IsoDateString;
}

export interface ListAuditEventsOutput {
  auditEvents: AuditEvent[];
}

export interface GetMemoryGraphInput {
  scopeIds?: ScopeId[];
  sessionId?: MemorySessionId;
  includeEvidence?: boolean;
}

export interface GetMemoryGraphOutput {
  graph: MemoryGraph;
}

export interface GetContextPackInput {
  contextPackId: ContextPackId;
}

export interface GetContextPackOutput {
  contextPack: ContextPack;
}

export interface ListSessionViolationsInput {
  sessionId?: MemorySessionId;
  kinds?: AgentContractViolationKind[];
  unresolvedOnly?: boolean;
}

export interface ListSessionViolationsOutput {
  violations: AgentContractViolation[];
}

export interface GovernMemoryInput {
  memoryId: MemoryId;
  reason: string;
  actor: string;
  evidenceRefs?: EvidenceRef[];
}

export interface GovernMemoryOutput {
  memory: MemoryObject;
  auditEvent: AuditEvent;
}

export interface ExportBundleInput {
  planes?: MemoryPlane[];
  scopeIds?: ScopeId[];
  includeSessions?: boolean;
}

export interface ExportBundleOutput {
  bundle: ExportBundle;
}

export interface ImportBundleInput {
  bundle: ImportBundle;
  mode: ImportMode;
}

export interface ImportBundleOutput {
  importedMemoryIds: MemoryId[];
  importedEvidenceIds: EvidenceId[];
  auditEvent: AuditEvent;
  previewOnly: boolean;
}

export interface BackupInput {
  path: string;
}

export interface BackupOutput {
  path: string;
  auditEvent: AuditEvent;
}

export interface SoulMemoryPublicApi {
  health(): Promise<HealthOutput>;
  getVersion(): Promise<{ version: string }>;
  getStorageStatus(): Promise<StorageStatusOutput>;
  doctor(): Promise<DoctorOutput>;
  previewIngest(input: PreviewIngestInput): Promise<PreviewIngestOutput>;
  ingestMemory(input: IngestMemoryInput): Promise<IngestMemoryOutput>;
  ingestEvidence(input: IngestEvidenceInput): Promise<IngestEvidenceOutput>;
  recall(input: RecallInput): Promise<RecallOutput>;
  assembleContext(input: AssembleContextInput): Promise<AssembleContextOutput>;
  startMemorySession(input: StartMemorySessionInput): Promise<StartMemorySessionOutput>;
  assembleContextForSession(
    sessionId: MemorySessionId,
    input: AssembleContextInput
  ): Promise<AssembleContextOutput>;
  recordMemoryUsage(input: RecordMemoryUsageInput): Promise<RecordMemoryUsageOutput>;
  recordMemoryIngest(input: RecordMemoryIngestInput): Promise<RecordMemoryIngestOutput>;
  finishMemorySession(
    sessionId: MemorySessionId,
    input: FinishMemorySessionInput
  ): Promise<FinishMemorySessionOutput>;
  getMemorySession(sessionId: MemorySessionId): Promise<{ session: MemorySession }>;
  explainRecall(input: ExplainRecallInput): Promise<ExplainRecallOutput>;
  getMemory(input: GetMemoryInput): Promise<GetMemoryOutput>;
  listMemories(input?: ListMemoriesInput): Promise<ListMemoriesOutput>;
  listEvidence(input?: ListEvidenceInput): Promise<ListEvidenceOutput>;
  listScopes(input?: ListScopesInput): Promise<ListScopesOutput>;
  listAuditEvents(input?: ListAuditEventsInput): Promise<ListAuditEventsOutput>;
  getMemoryGraph(input?: GetMemoryGraphInput): Promise<GetMemoryGraphOutput>;
  getContextPack(input: GetContextPackInput): Promise<GetContextPackOutput>;
  listSessionViolations(
    input?: ListSessionViolationsInput
  ): Promise<ListSessionViolationsOutput>;
  acceptMemory(input: GovernMemoryInput): Promise<GovernMemoryOutput>;
  rejectMemory(input: GovernMemoryInput): Promise<GovernMemoryOutput>;
  retireMemory(input: GovernMemoryInput): Promise<GovernMemoryOutput>;
  markSensitive(input: GovernMemoryInput & { policy?: SensitivityPolicy }): Promise<GovernMemoryOutput>;
  exportBundle(input?: ExportBundleInput): Promise<ExportBundleOutput>;
  importBundle(input: ImportBundleInput): Promise<ImportBundleOutput>;
  backup(input: BackupInput): Promise<BackupOutput>;
}

export class ContractValidationError extends Error {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
  }
}

export interface MemoryObjectValidationOptions {
  knownEvidenceIds?: ReadonlySet<string> | readonly string[];
}

export function validateScope(value: unknown): Scope {
  const record = asRecord(value, "scope");
  requireString(record.id, "scope.id");
  requireOneOf(record.plane, MEMORY_PLANES, "scope.plane");
  requireOneOf(record.kind, SCOPE_KINDS, "scope.kind");
  requireString(record.name, "scope.name");
  const identity = requireString(record.identity, "scope.identity");
  if (record.plane === "project-local" && identity.trim().length === 0) {
    fail("project/local scope requires project, workspace, repo, path, or task identity", "scope.identity");
  }
  return value as Scope;
}

export function validateEvidence(value: unknown): Evidence {
  const record = asRecord(value, "evidence");
  requireString(record.id, "evidence.id");
  requireOneOf(record.type, EVIDENCE_TYPES, "evidence.type");
  validateSourceRef(record.source, "evidence.source");
  requireString(record.summary, "evidence.summary");
  requireString(record.createdAt, "evidence.createdAt");
  if (record.payload === undefined && record.pointer === undefined) {
    fail("evidence requires payload or pointer", "evidence");
  }
  if (record.pointer !== undefined) {
    requireString(record.pointer, "evidence.pointer");
  }
  if (record.confidence !== undefined) {
    requireScore(record.confidence, "evidence.confidence");
  }
  return value as Evidence;
}

export function validateMemoryObject(
  value: unknown,
  options: MemoryObjectValidationOptions = {}
): MemoryObject {
  const record = asRecord(value, "memory");
  requireString(record.id, "memory.id");
  requireOneOf(record.plane, MEMORY_PLANES, "memory.plane");
  requireString(record.scopeId, "memory.scopeId");
  requireOneOf(record.kind, MEMORY_KINDS, "memory.kind");
  requireOneOf(record.durability, MEMORY_DURABILITIES, "memory.durability");
  requireOneOf(record.lifecycle, MEMORY_LIFECYCLES, "memory.lifecycle");
  validateMemoryContent(record.content);
  validateFacetArray(record.facets, "memory.facets");
  if (record.source !== null) {
    validateSourceRef(record.source, "memory.source");
  }
  const evidenceIds = requireStringArray(record.evidenceIds, "memory.evidenceIds");
  requireScore(record.confidence, "memory.confidence");
  requireScore(record.strength, "memory.strength");
  requireString(record.createdAt, "memory.createdAt");

  if (record.durability === "durable") {
    if (record.source === null || record.source === undefined) {
      fail("durable memory requires a source reference", "memory.source");
    }
    if (evidenceIds.length === 0) {
      fail("durable memory requires at least one evidence id", "memory.evidenceIds");
    }
  }

  const knownEvidenceIds = normalizeKnownIds(options.knownEvidenceIds);
  if (knownEvidenceIds !== undefined) {
    for (const evidenceId of evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) {
        fail(`unknown evidence id '${evidenceId}'`, "memory.evidenceIds");
      }
    }
  }

  return value as MemoryObject;
}

export function validateRecallCandidate(value: unknown): RecallCandidate {
  const record = asRecord(value, "recallCandidate");
  requireString(record.id, "recallCandidate.id");
  requireString(record.memoryId, "recallCandidate.memoryId");
  requireOneOf(record.plane, MEMORY_PLANES, "recallCandidate.plane");
  requireNonNegativeNumber(record.rank, "recallCandidate.rank");
  requireScore(record.score, "recallCandidate.score");
  requireString(record.reason, "recallCandidate.reason");
  requireOneOf(record.recommendedUse, USAGE_RECOMMENDATIONS, "recallCandidate.recommendedUse");
  validateEvidenceRefs(record.evidenceRefs, "recallCandidate.evidenceRefs");
  validateSourceRef(record.sourceRef, "recallCandidate.sourceRef");
  requireOneOf(record.lifecycle, MEMORY_LIFECYCLES, "recallCandidate.lifecycle");
  return value as RecallCandidate;
}

export function validateContextPack(value: unknown): ContextPack {
  const record = asRecord(value, "contextPack");
  requireString(record.id, "contextPack.id");
  requireString(record.query, "contextPack.query");
  requireOneOf(
    record.planePolicy,
    ["all-day-one", "global-only", "project-only", "explicit"] as const,
    "contextPack.planePolicy"
  );
  requireString(record.recallPolicyVersion, "contextPack.recallPolicyVersion");
  requireString(record.createdAt, "contextPack.createdAt");
  requireString(record.explanationSummary, "contextPack.explanationSummary");

  const included = requireArray(record.included, "contextPack.included");
  for (const [index, entry] of included.entries()) {
    validateContextPackEntry(entry, `contextPack.included[${index}]`);
  }

  const excluded = requireArray(record.excluded, "contextPack.excluded");
  for (const [index, exclusion] of excluded.entries()) {
    validateRecallExclusion(exclusion, `contextPack.excluded[${index}]`);
  }

  const totalIncludedCount = requireNonNegativeNumber(
    record.totalIncludedCount,
    "contextPack.totalIncludedCount"
  );
  const totalExcludedCount = requireNonNegativeNumber(
    record.totalExcludedCount,
    "contextPack.totalExcludedCount"
  );
  if (totalIncludedCount !== included.length) {
    fail("must match included entry count", "contextPack.totalIncludedCount");
  }
  if (totalExcludedCount !== excluded.length) {
    fail("must match excluded entry count", "contextPack.totalExcludedCount");
  }

  return value as ContextPack;
}

export function validateMemorySession(value: unknown): MemorySession {
  const record = asRecord(value, "memorySession");
  requireString(record.id, "memorySession.id");
  const agent = asRecord(record.agent, "memorySession.agent");
  requireString(agent.kind, "memorySession.agent.kind");
  requireOneOf(record.mode, SESSION_MODES, "memorySession.mode");
  requireString(record.startedAt, "memorySession.startedAt");
  requireOneOf(record.usageState, SESSION_USAGE_STATES, "memorySession.usageState");
  requireOneOf(record.ingestState, INGEST_STATES, "memorySession.ingestState");

  const delivered = requireStringArray(record.deliveredMemoryIds, "memorySession.deliveredMemoryIds");
  const used = requireStringArray(record.usedMemoryIds, "memorySession.usedMemoryIds");
  const skipped = requireStringArray(record.skippedMemoryIds, "memorySession.skippedMemoryIds");
  const unverifiable = requireStringArray(
    record.unverifiableMemoryIds,
    "memorySession.unverifiableMemoryIds"
  );
  const deliveredSet = new Set(delivered);
  for (const [path, ids] of [
    ["memorySession.usedMemoryIds", used],
    ["memorySession.skippedMemoryIds", skipped],
    ["memorySession.unverifiableMemoryIds", unverifiable]
  ] as const) {
    for (const id of ids) {
      if (!deliveredSet.has(id)) {
        fail(`memory id '${id}' was not delivered before session outcome was recorded`, path);
      }
    }
  }

  const summary = asRecord(record.violationSummary, "memorySession.violationSummary");
  requireNonNegativeNumber(summary.blocking, "memorySession.violationSummary.blocking");
  requireNonNegativeNumber(summary.important, "memorySession.violationSummary.important");
  requireNonNegativeNumber(summary.niceToHave, "memorySession.violationSummary.niceToHave");
  return value as MemorySession;
}

export function validateExportBundle(value: unknown): ExportBundle {
  const record = asRecord(value, "bundle");
  if (record.schemaVersion !== EXPORT_BUNDLE_SCHEMA_VERSION) {
    fail(`expected schema version '${EXPORT_BUNDLE_SCHEMA_VERSION}'`, "bundle.schemaVersion");
  }
  requireString(record.exportedAt, "bundle.exportedAt");

  for (const [index, scope] of requireArray(record.scopes, "bundle.scopes").entries()) {
    try {
      validateScope(scope);
    } catch (error) {
      rethrowAt(error, `bundle.scopes[${index}]`);
    }
  }

  const evidence = requireArray(record.evidence, "bundle.evidence");
  const knownEvidenceIds = new Set<string>();
  for (const [index, item] of evidence.entries()) {
    try {
      const validated = validateEvidence(item);
      knownEvidenceIds.add(validated.id);
    } catch (error) {
      rethrowAt(error, `bundle.evidence[${index}]`);
    }
  }

  for (const [index, memory] of requireArray(record.memories, "bundle.memories").entries()) {
    try {
      validateMemoryObject(memory, { knownEvidenceIds });
    } catch (error) {
      rethrowAt(error, `bundle.memories[${index}]`);
    }
  }

  for (const [index, event] of requireArray(record.auditEvents, "bundle.auditEvents").entries()) {
    validateAuditEvent(event, `bundle.auditEvents[${index}]`);
  }

  if (record.sessions !== undefined) {
    for (const [index, session] of requireArray(record.sessions, "bundle.sessions").entries()) {
      try {
        validateMemorySession(session);
      } catch (error) {
        rethrowAt(error, `bundle.sessions[${index}]`);
      }
    }
  }

  if (record.contextPacks !== undefined) {
    for (const [index, contextPack] of requireArray(record.contextPacks, "bundle.contextPacks").entries()) {
      try {
        validateContextPack(contextPack);
      } catch (error) {
        rethrowAt(error, `bundle.contextPacks[${index}]`);
      }
    }
  }

  return value as ExportBundle;
}

function validateContextPackEntry(value: unknown, path: string): ContextPackEntry {
  const record = asRecord(value, path);
  requireString(record.id, `${path}.id`);
  requireString(record.memoryId, `${path}.memoryId`);
  requireOneOf(record.plane, MEMORY_PLANES, `${path}.plane`);
  requireNonNegativeNumber(record.rank, `${path}.rank`);
  requireScore(record.score, `${path}.score`);
  requireString(record.reason, `${path}.reason`);
  requireOneOf(record.recommendedUse, USAGE_RECOMMENDATIONS, `${path}.recommendedUse`);
  validateEvidenceRefs(record.evidenceRefs, `${path}.evidenceRefs`);
  validateSourceRef(record.sourceRef, `${path}.sourceRef`);
  return value as ContextPackEntry;
}

function validateRecallExclusion(value: unknown, path: string): RecallExclusion {
  const record = asRecord(value, path);
  requireString(record.id, `${path}.id`);
  requireString(record.memoryId, `${path}.memoryId`);
  requireOneOf(record.plane, MEMORY_PLANES, `${path}.plane`);
  requireString(record.reason, `${path}.reason`);
  validateEvidenceRefs(record.evidenceRefs, `${path}.evidenceRefs`);
  requireOneOf(record.lifecycle, MEMORY_LIFECYCLES, `${path}.lifecycle`);
  return value as RecallExclusion;
}

function validateAuditEvent(value: unknown, path: string): AuditEvent {
  const record = asRecord(value, path);
  requireString(record.id, `${path}.id`);
  requireOneOf(record.type, AUDIT_EVENT_KINDS, `${path}.type`);
  requireString(record.at, `${path}.at`);
  requireString(record.actor, `${path}.actor`);
  const target = asRecord(record.target, `${path}.target`);
  requireOneOf(
    target.type,
    ["memory", "scope", "evidence", "session", "context-pack", "bundle"] as const,
    `${path}.target.type`
  );
  requireString(target.id, `${path}.target.id`);
  requireString(record.reason, `${path}.reason`);
  if (record.evidenceRefs !== undefined) {
    validateEvidenceRefs(record.evidenceRefs, `${path}.evidenceRefs`);
  }
  return value as AuditEvent;
}

function validateMemoryContent(value: unknown): MemoryContent {
  const record = asRecord(value, "memory.content");
  requireString(record.summary, "memory.content.summary");
  if (record.body !== undefined) {
    requireString(record.body, "memory.content.body");
  }
  if (record.language !== undefined) {
    requireString(record.language, "memory.content.language");
  }
  return value as MemoryContent;
}

function validateFacetArray(value: unknown, path: string): MemoryFacet[] {
  const facets = requireArray(value, path);
  for (const [index, facet] of facets.entries()) {
    const record = asRecord(facet, `${path}[${index}]`);
    requireString(record.key, `${path}[${index}].key`);
    requireString(record.value, `${path}[${index}].value`);
    if (record.confidence !== undefined) {
      requireScore(record.confidence, `${path}[${index}].confidence`);
    }
  }
  return value as MemoryFacet[];
}

function validateEvidenceRefs(value: unknown, path: string): EvidenceRef[] {
  const refs = requireArray(value, path);
  if (refs.length === 0) {
    fail("requires at least one evidence reference", path);
  }
  for (const [index, ref] of refs.entries()) {
    const record = asRecord(ref, `${path}[${index}]`);
    requireString(record.evidenceId, `${path}[${index}].evidenceId`);
    if (record.sourceId !== undefined) {
      requireString(record.sourceId, `${path}[${index}].sourceId`);
    }
    if (record.note !== undefined) {
      requireString(record.note, `${path}[${index}].note`);
    }
  }
  return value as EvidenceRef[];
}

function validateSourceRef(value: unknown, path: string): SourceRef {
  const record = asRecord(value, path);
  requireString(record.id, `${path}.id`);
  requireOneOf(record.type, SOURCE_TYPES, `${path}.type`);
  requireString(record.ref, `${path}.ref`);
  if (record.actor !== undefined) {
    requireString(record.actor, `${path}.actor`);
  }
  if (record.observedAt !== undefined) {
    requireString(record.observedAt, `${path}.observedAt`);
  }
  return value as SourceRef;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("expected object", path);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("expected non-empty string", path);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  const array = requireArray(value, path);
  for (const [index, item] of array.entries()) {
    requireString(item, `${path}[${index}]`);
  }
  return array as string[];
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail("expected array", path);
  }
  return value;
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(`expected one of ${allowed.join(", ")}`, path);
  }
  return value;
}

function requireScore(value: unknown, path: string): number {
  const numberValue = requireNumber(value, path);
  if (numberValue < 0 || numberValue > 1) {
    fail("expected number between 0 and 1", path);
  }
  return numberValue;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const numberValue = requireNumber(value, path);
  if (numberValue < 0) {
    fail("expected non-negative number", path);
  }
  return numberValue;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("expected finite number", path);
  }
  return value;
}

function normalizeKnownIds(ids: MemoryObjectValidationOptions["knownEvidenceIds"]): Set<string> | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return ids instanceof Set ? ids : new Set(ids);
}

function fail(message: string, path: string): never {
  throw new ContractValidationError(message, path);
}

function rethrowAt(error: unknown, path: string): never {
  if (error instanceof ContractValidationError) {
    throw new ContractValidationError(error.message, path);
  }
  throw error;
}
