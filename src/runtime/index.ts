import { existsSync } from "node:fs";
import {
  type AgentContractViolation,
  type AssembleContextInput,
  type AssembleContextOutput,
  type AuditEvent,
  type BackupInput,
  type BackupOutput,
  CONTRACT_SCHEMA_VERSION,
  type ContextPack,
  type ContextPackEntry,
  type DoctorOutput,
  type Evidence,
  type EvidenceRef,
  EXPORT_BUNDLE_SCHEMA_VERSION,
  type ExplainRecallInput,
  type ExplainRecallOutput,
  type ExportBundle,
  type ExportBundleInput,
  type ExportBundleOutput,
  type FinishMemorySessionInput,
  type FinishMemorySessionOutput,
  type GetContextPackInput,
  type GetContextPackOutput,
  type GetMemoryGraphInput,
  type GetMemoryGraphOutput,
  type GetMemoryInput,
  type GetMemoryOutput,
  type GovernMemoryInput,
  type GovernMemoryOutput,
  type HealthOutput,
  type ImportBundleInput,
  type ImportBundleOutput,
  type IngestEvidenceInput,
  type IngestEvidenceOutput,
  type IngestMemoryInput,
  type IngestMemoryOutput,
  type JsonValue as ContractJsonValue,
  type ListAuditEventsInput,
  type ListAuditEventsOutput,
  type ListEvidenceInput,
  type ListEvidenceOutput,
  type ListMemoriesInput,
  type ListMemoriesOutput,
  type ListScopesInput,
  type ListScopesOutput,
  type ListSessionViolationsInput,
  type ListSessionViolationsOutput,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryLifecycle,
  type MemoryObject,
  type MemoryPlane as ContractMemoryPlane,
  type MemorySession,
  type MemorySessionId,
  type PreviewIngestInput,
  type PreviewIngestOutput,
  type RecallCandidate,
  type RecallExclusion,
  type RecallInput,
  type RecallOutput,
  type RecordMemoryIngestInput,
  type RecordMemoryIngestOutput,
  type RecordMemoryUsageInput,
  type RecordMemoryUsageOutput,
  type Scope,
  type SensitivityPolicy,
  type SoulMemoryPublicApi,
  type SourceRef,
  type StartMemorySessionInput,
  type StartMemorySessionOutput,
  type StorageStatusOutput,
  validateContextPack,
  validateEvidence,
  validateExportBundle,
  validateMemoryObject,
  validateMemorySession,
  validateScope
} from "../contracts/index.js";
import {
  createSoulMemoryStorage,
  type AuditEventRecord,
  type ContextPackRecord,
  type EvidenceRecord,
  type MemoryEdgeRecord,
  type MemoryGovernanceState,
  type MemoryIngestEventRecord,
  type MemoryPlane as StorageMemoryPlane,
  type MemoryRecord,
  type MemorySessionRecord,
  type MemoryUsageEventRecord,
  type ScopeRecord,
  type SqliteSoulMemoryStorage,
  type SoulMemoryStorageOptions,
  type StorageJsonValue
} from "../storage/index.js";

export const SOUL_MEMORY_RUNTIME_VERSION = "0.0.0-local";
export const RECALL_POLICY_VERSION = "soul-memory.lexical-v1";

export interface SoulMemoryRuntimeOptions extends SoulMemoryStorageOptions {
  readonly storage?: SqliteSoulMemoryStorage;
}

export class RuntimeError extends Error {
  public constructor(
    public readonly code:
      | "NOT_FOUND"
      | "VALIDATION_FAILED"
      | "UNSUPPORTED_PLANE"
      | "IMPORT_REPLACE_UNSUPPORTED",
    message: string
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class SoulMemoryRuntime implements SoulMemoryPublicApi {
  private readonly storage: SqliteSoulMemoryStorage;
  private readonly ownsStorage: boolean;

  public constructor(options: SoulMemoryRuntimeOptions = {}) {
    this.storage = options.storage ?? createSoulMemoryStorage(options);
    this.ownsStorage = options.storage === undefined;
  }

  public close(): void {
    if (this.ownsStorage) {
      this.storage.close();
    }
  }

  public async health(): Promise<HealthOutput> {
    return {
      ok: this.storage.health().ok,
      version: SOUL_MEMORY_RUNTIME_VERSION,
      schemaVersion: CONTRACT_SCHEMA_VERSION
    };
  }

  public async getVersion(): Promise<{ version: string }> {
    return { version: SOUL_MEMORY_RUNTIME_VERSION };
  }

  public async getStorageStatus(): Promise<StorageStatusOutput> {
    const health = this.storage.health();
    return {
      ready: health.ok,
      location: health.path,
      migrationsApplied: [`baseline:${health.schemaVersion}`],
      warnings: health.schemaVersion === 0 ? ["storage schema has not been migrated"] : []
    };
  }

  public async doctor(): Promise<DoctorOutput> {
    const status = await this.getStorageStatus();
    return {
      ok: status.ready,
      checks: [
        {
          name: "storage",
          ok: status.ready,
          message: status.location
        },
        {
          name: "schema",
          ok: (status.migrationsApplied ?? []).length > 0,
          message: (status.migrationsApplied ?? []).join(", ")
        },
        {
          name: "standalone",
          ok: true,
          message: "runtime uses local contracts and node:sqlite storage"
        }
      ]
    };
  }

  public async previewIngest(input: PreviewIngestInput): Promise<PreviewIngestOutput> {
    const validation = this.validateIngest(input);
    return {
      accepted: validation.reasons.length === 0,
      reasons: validation.reasons,
      memory: input.memory
    };
  }

  public async ingestMemory(input: IngestMemoryInput): Promise<IngestMemoryOutput> {
    const validation = this.validateIngest(input);
    if (validation.reasons.length > 0 || validation.memory === undefined || validation.evidence === undefined) {
      throw new RuntimeError("VALIDATION_FAILED", validation.reasons.join("; "));
    }
    const memory = validation.memory;
    const evidence = validation.evidence;

    return this.storage.transaction(() => this.persistMemory(memory, evidence));
  }

  private validateIngest(input: PreviewIngestInput): {
    readonly reasons: string[];
    readonly memory?: MemoryObject;
    readonly evidence?: Evidence[];
  } {
    const reasons: string[] = [];
    let memory: MemoryObject | undefined;
    let evidence: Evidence[] | undefined;
    try {
      memory = validateMemoryObject(input.memory);
      evidence = (input.evidence ?? []).map((item) => validateEvidence(item));
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
      return { reasons };
    }

    if (!isDayOnePlane(memory.plane)) {
      reasons.push(`memory plane '${memory.plane}' is not enabled in the day-one runtime`);
    }
    if (memory.durability === "durable") {
      if (evidence.length === 0) {
        reasons.push("durable memory requires matching evidence payloads or pointers");
      }
      const provided = new Set(evidence.map((item) => item.id));
      for (const evidenceId of memory.evidenceIds) {
        if (!provided.has(evidenceId)) {
          reasons.push(`memory evidence id '${evidenceId}' was not provided`);
        }
      }
    }

    return { reasons, memory, evidence };
  }

  private persistMemory(memory: MemoryObject, evidence: readonly Evidence[]): IngestMemoryOutput {
    this.ensureScope(memory);
    const storageMemory = this.storage.createMemory({
      memoryId: memory.id,
      plane: toStoragePlane(memory.plane),
      scopeId: memory.scopeId,
      title: memory.content.summary,
      body: memory.content.body ?? memory.content.summary,
      sourceType: memory.source?.type ?? "operator",
      sourceRef: memory.source?.ref ?? memory.source?.id ?? "unknown-source",
      lifecycleState: toStorageLifecycle(memory.lifecycle),
      governanceState: toStorageGovernance(memory.lifecycle),
      strength: memory.strength,
      sensitivity: memory.sensitivity?.level === "sensitive" || memory.lifecycle === "sensitive" ? "sensitive" : "normal",
      metadata: asStorageJson(memoryToMetadata(memory))
    });

    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    for (const evidenceId of memory.evidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (item === undefined) {
        throw new RuntimeError("VALIDATION_FAILED", `Evidence '${evidenceId}' is required for memory ${memory.id}.`);
      }
      this.storage.addEvidence({
        evidenceId,
        memoryId: storageMemory.memoryId,
        sourceType: item.source.type,
        sourceRef: item.source.ref,
        payload: asStorageJson(item.payload ?? {
          pointer: item.pointer ?? null,
          summary: item.summary
        }),
        createdAt: item.createdAt
      });
    }

    const audit = this.addAuditEvent({
      type: "memory.created",
      targetType: "memory",
      targetId: memory.id,
      actor: memory.source?.actor ?? "operator",
      reason: memory.evidenceIds.length > 0 ? "Evidence-backed memory ingested." : "Draft memory ingested.",
      evidenceRefs: memory.evidenceIds.map((evidenceId) => ({ evidenceId }))
    });

    return {
      memory: this.toMemoryObject(storageMemory),
      auditEvent: audit
    };
  }

  public async ingestEvidence(input: IngestEvidenceInput): Promise<IngestEvidenceOutput> {
    const evidence = validateEvidence(input.evidence);
    const memoryId = input.memoryId ?? evidenceMemoryId(evidence);
    if (memoryId === undefined) {
      throw new RuntimeError(
        "VALIDATION_FAILED",
        "ingestEvidence requires input.memoryId or payload.memoryId for this local SQLite prototype"
      );
    }
    if (this.storage.getMemory(memoryId) === null) {
      throw new RuntimeError("NOT_FOUND", `Memory ${memoryId} was not found for evidence ${evidence.id}.`);
    }

    this.storage.addEvidence({
      evidenceId: evidence.id,
      memoryId,
      sourceType: evidence.source.type,
      sourceRef: evidence.source.ref,
      payload: asStorageJson(evidence.payload ?? { pointer: evidence.pointer ?? null, summary: evidence.summary }),
      createdAt: evidence.createdAt
    });
    this.addAuditEvent({
      type: "memory.created",
      targetType: "evidence",
      targetId: evidence.id,
      actor: evidence.source.actor ?? "operator",
      reason: "Evidence ingested for durable memory.",
      evidenceRefs: [{ evidenceId: evidence.id, sourceId: evidence.source.id }]
    });
    return { evidence };
  }

  public async recall(input: RecallInput): Promise<RecallOutput> {
    if (typeof input.query !== "string" || input.query.trim().length === 0) {
      throw new RuntimeError("VALIDATION_FAILED", "recall.query is required.");
    }
    const limit = input.limit ?? 8;
    const planes = input.planes ?? ["project-local", "global-personal"];
    const storagePlanes = planes.map(toStoragePlane);
    const scopeIds = input.scopeIds ?? [];
    const candidates = this.storage
      .searchMemories(input.query, { limit: Math.max(limit * 4, 16) })
      .filter((memory) => storagePlanes.includes(memory.plane))
      .filter((memory) => scopeIds.length === 0 || (memory.scopeId !== null && scopeIds.includes(memory.scopeId)));
    const included: RecallCandidate[] = [];
    const exclusions: RecallExclusion[] = [];

    for (const memory of candidates) {
      const lifecycle = fromStorageLifecycle(memory);
      const evidenceRefs = this.evidenceRefsForMemory(memory.memoryId);
      if (memory.governanceState === "rejected" || memory.lifecycleState === "rejected") {
        exclusions.push(toRecallExclusion(memory, "Memory is rejected and cannot be recalled.", evidenceRefs));
        continue;
      }
      if (memory.governanceState === "retired" || memory.lifecycleState === "retired") {
        exclusions.push(toRecallExclusion(memory, "Memory is retired.", evidenceRefs));
        continue;
      }
      if (memory.sensitivity === "sensitive") {
        exclusions.push(toRecallExclusion(memory, "Sensitive memory requires explicit operator action.", evidenceRefs));
        continue;
      }
      if (included.length >= limit) {
        exclusions.push(toRecallExclusion(memory, "Candidate was below the configured recall limit.", evidenceRefs));
        continue;
      }

      included.push({
        id: `recall:${memory.memoryId}`,
        memoryId: memory.memoryId,
        plane: fromStoragePlane(memory.plane),
        rank: included.length + 1,
        score: scoreMemory(input.query, memory),
        reason: recallReason(input.query, memory),
        recommendedUse: memory.governanceState === "accepted" ? "blocking" : "advisory",
        evidenceRefs,
        sourceRef: sourceRefFromMemory(memory),
        lifecycle,
        flags: {
          sensitive: false,
          stale: lifecycle === "superseded",
          superseded: lifecycle === "superseded"
        }
      });
    }

    this.addAuditEvent({
      type: "recall.performed",
      targetType: "bundle",
      targetId: `recall:${Date.now()}`,
      actor: "runtime",
      reason: `Recall query '${input.query}' returned ${included.length} included candidate(s).`
    });

    return {
      candidates: included,
      exclusions,
      explanationSummary:
        included.length === 0
          ? "No eligible memories matched the query."
          : `Returned ${included.length} explainable memory candidate(s).`
    };
  }

  public async assembleContext(input: AssembleContextInput): Promise<AssembleContextOutput> {
    const recall = await this.recall(input);
    const contextPack: ContextPack = validateContextPack({
      id: `context:${cryptoRandomId()}`,
      sessionId: input.sessionId,
      requestId: input.requestId ?? `request:${cryptoRandomId()}`,
      query: input.query,
      planePolicy: toPlanePolicy(input.planes),
      recallPolicyVersion: RECALL_POLICY_VERSION,
      createdAt: nowIso(),
      included: recall.candidates.map((candidate): ContextPackEntry => ({
        id: `entry:${candidate.memoryId}`,
        memoryId: candidate.memoryId,
        plane: candidate.plane,
        rank: candidate.rank,
        score: candidate.score,
        reason: candidate.reason,
        recommendedUse: candidate.recommendedUse,
        evidenceRefs: candidate.evidenceRefs,
        sourceRef: candidate.sourceRef,
        flags: candidate.flags
      })),
      excluded: recall.exclusions,
      totalIncludedCount: recall.candidates.length,
      totalExcludedCount: recall.exclusions.length,
      explanationSummary: recall.explanationSummary
    });

    this.storage.createContextPack({
      contextPackId: contextPack.id,
      sessionId: input.sessionId ?? null,
      requestId: contextPack.requestId,
      queryText: input.query,
      planePolicy: { planes: input.planes ?? ["project-local", "global-personal"] },
      recallPolicyVersion: RECALL_POLICY_VERSION,
      explanationSummary: contextPack.explanationSummary
    });
    for (const entry of contextPack.included) {
      this.storage.addContextPackEntry({
        entryId: entry.id,
        contextPackId: contextPack.id,
        memoryId: entry.memoryId,
        memoryPlane: toStoragePlane(entry.plane),
        usageRecommendation: entry.recommendedUse,
        score: entry.score,
        rank: entry.rank,
        reason: entry.reason,
        sourceRefs: asStorageJson(entry.evidenceRefs),
        isSensitive: entry.flags?.sensitive ?? false,
        isStale: entry.flags?.stale ?? false,
        hasConflict: entry.flags?.conflicted ?? false
      });
    }
    for (const exclusion of contextPack.excluded) {
      this.storage.addRecallExclusion({
        exclusionId: exclusion.id,
        contextPackId: contextPack.id,
        memoryId: exclusion.memoryId,
        sourcePlane: toStoragePlane(exclusion.plane),
        reason: exclusion.reason,
        evidenceId: exclusion.evidenceRefs[0]?.evidenceId,
        lifecycleState: exclusion.lifecycle,
        conflictRef: exclusion.conflictWithMemoryId,
        supersededByMemoryId: exclusion.supersededByMemoryId
      });
    }

    this.addAuditEvent({
      type: "context_pack.assembled",
      targetType: "context-pack",
      targetId: contextPack.id,
      actor: "runtime",
      reason: contextPack.explanationSummary
    });

    return { contextPack };
  }

  public async startMemorySession(input: StartMemorySessionInput): Promise<StartMemorySessionOutput> {
    const session = this.storage.startMemorySession({
      agentKind: input.agent.kind,
      clientVersion: input.agent.version ?? input.agent.client,
      mode: input.mode,
      hostRef: input.host,
      projectRef: input.project,
      workspaceRef: input.workspace,
      usageState: "not-delivered",
      postRunIngestState: "not-requested",
      metadata: { agent: input.agent }
    });
    this.addAuditEvent({
      type: "session.started",
      targetType: "session",
      targetId: session.sessionId,
      actor: input.agent.kind,
      reason: "Memory session started."
    });
    return { session: this.toMemorySession(session) };
  }

  public async assembleContextForSession(
    sessionId: MemorySessionId,
    input: AssembleContextInput
  ): Promise<AssembleContextOutput> {
    const session = this.requireSession(sessionId);
    const output = await this.assembleContext({ ...input, sessionId });
    this.storage.updateMemorySession(sessionId, {
      contextPackId: output.contextPack.id,
      usageState: "delivered",
      postRunIngestState: session.postRunIngestState
    });
    for (const entry of output.contextPack.included) {
      this.storage.recordMemoryUsage({
        sessionId,
        contextPackId: output.contextPack.id,
        memoryId: entry.memoryId,
        eventType: "recall-item-delivered",
        payload: { state: "delivered", reason: entry.reason }
      });
    }
    return output;
  }

  public async recordMemoryUsage(input: RecordMemoryUsageInput): Promise<RecordMemoryUsageOutput> {
    const event = input.event;
    const proof = typeof event.proof === "string" && event.proof.trim().length > 0
      ? event.proof
      : undefined;
    const state = event.state === "used" && proof === undefined ? "unverifiable" : event.state;
    this.storage.recordMemoryUsage({
      usageEventId: event.id,
      sessionId: event.sessionId,
      contextPackId: event.contextPackId,
      memoryId: event.memoryId,
      eventType: event.kind,
      proofRef: proof,
      payload: asStorageJson({
        state,
        reason: event.reason ?? null
      }),
      createdAt: event.at
    });
    if (event.state === "used" && proof === undefined) {
      this.storage.recordViolation({
        sessionId: event.sessionId,
        violationType: "used-memory-without-proof",
        severity: "warning",
        summary: "Memory usage was marked used without non-empty proof.",
        payload: { memoryId: event.memoryId ?? null, usageEventId: event.id }
      });
    }
    const session = this.requireSession(event.sessionId);
    this.storage.updateMemorySession(event.sessionId, {
      contextPackId: event.contextPackId ?? session.contextPackId,
      usageState: state
    });
    return {
      event: { ...event, state, proof },
      session: this.toMemorySession(this.requireSession(event.sessionId))
    };
  }

  public async recordMemoryIngest(input: RecordMemoryIngestInput): Promise<RecordMemoryIngestOutput> {
    const event = input.event;
    this.storage.recordMemoryIngest({
      ingestEventId: event.id,
      sessionId: event.sessionId,
      memoryId: event.memoryId,
      eventType: event.kind,
      outcome: event.state,
      payload: asStorageJson({
        evidenceIds: event.evidenceIds ?? [],
        reason: event.reason ?? null
      }),
      createdAt: event.at
    });
    const session = this.requireSession(event.sessionId);
    this.storage.updateMemorySession(event.sessionId, {
      contextPackId: session.contextPackId,
      postRunIngestState: event.state
    });
    return {
      event,
      session: this.toMemorySession(this.requireSession(event.sessionId))
    };
  }

  public async finishMemorySession(
    sessionId: MemorySessionId,
    input: FinishMemorySessionInput
  ): Promise<FinishMemorySessionOutput> {
    const usageEvents = this.storage.listMemoryUsageEvents({ sessionId, limit: 1000 });
    const delivered = idsForUsageState(usageEvents, "delivered");
    const used = idsForProvenUsage(usageEvents).filter((id) => delivered.includes(id));
    let usageState = input.usageState;
    if (input.usageState === "used" && used.length === 0) {
      this.storage.recordViolation({
        sessionId,
        violationType: "usage-state-without-proof",
        severity: "warning",
        summary: "Session was finished as used without delivered memory usage proof.",
        payload: { requestedUsageState: input.usageState }
      });
      usageState = "unverifiable";
    }
    const session = this.storage.finishMemorySession(sessionId, {
      finishedAt: input.finishedAt,
      usageState,
      postRunIngestState: input.ingestState,
      violationSummary: this.violationSummaryForSession(sessionId)
    });
    this.addAuditEvent({
      type: "session.finished",
      targetType: "session",
      targetId: sessionId,
      actor: session.agentKind,
      reason: `Memory session finished with usage=${usageState}, ingest=${input.ingestState}.`
    });
    return { session: this.toMemorySession(session) };
  }

  public async getMemorySession(sessionId: MemorySessionId): Promise<{ session: MemorySession }> {
    return { session: this.toMemorySession(this.requireSession(sessionId)) };
  }

  public async explainRecall(input: ExplainRecallInput): Promise<ExplainRecallOutput> {
    const memoryId = input.candidateId.startsWith("recall:")
      ? input.candidateId.slice("recall:".length)
      : input.candidateId;
    const memory = this.requireMemory(memoryId);
    return {
      candidate: {
        id: `recall:${memory.memoryId}`,
        memoryId: memory.memoryId,
        plane: fromStoragePlane(memory.plane),
        rank: 1,
        score: 1,
        reason: `Candidate explains memory '${memory.title}' from ${memory.plane}.`,
        recommendedUse: memory.governanceState === "accepted" ? "blocking" : "advisory",
        evidenceRefs: this.evidenceRefsForMemory(memory.memoryId),
        sourceRef: sourceRefFromMemory(memory),
        lifecycle: fromStorageLifecycle(memory)
      }
    };
  }

  public async getMemory(input: GetMemoryInput): Promise<GetMemoryOutput> {
    return { memory: sanitizeMemoryForRead(this.toMemoryObject(this.requireMemory(input.memoryId)), "read") };
  }

  public async listMemories(input: ListMemoriesInput = {}): Promise<ListMemoriesOutput> {
    const memories = this.storage
      .listMemories({
        plane: input.planes?.length === 1 ? toStoragePlane(input.planes[0]) : undefined,
        scopeId: input.scopeIds?.length === 1 ? input.scopeIds[0] : undefined,
        lifecycleState: input.lifecycle?.length === 1 ? toStorageLifecycle(input.lifecycle[0]) : undefined,
        limit: 1000
      })
      .filter((memory) => input.planes === undefined || input.planes.includes(fromStoragePlane(memory.plane)))
      .filter((memory) => input.scopeIds === undefined || (memory.scopeId !== null && input.scopeIds.includes(memory.scopeId)))
      .filter((memory) => input.lifecycle === undefined || input.lifecycle.includes(fromStorageLifecycle(memory)))
      .map((memory) => sanitizeMemoryForRead(this.toMemoryObject(memory), "read"));
    return { memories };
  }

  public async listEvidence(input: ListEvidenceInput = {}): Promise<ListEvidenceOutput> {
    if (input.memoryId !== undefined) {
      return { evidence: this.storage.listEvidence(input.memoryId).map((evidence) => this.toPublicEvidence(evidence, "read")) };
    }
    const memories = this.storage.listMemories({ limit: 1000 });
    return {
      evidence: memories.flatMap((memory) => this.storage.listEvidence(memory.memoryId).map((evidence) => this.toPublicEvidence(evidence, "read")))
    };
  }

  public async listScopes(input: ListScopesInput = {}): Promise<ListScopesOutput> {
    const scopes = this.storage
      .listScopes(input.planes?.length === 1 ? toStoragePlane(input.planes[0]) : undefined)
      .filter((scope) => input.planes === undefined || input.planes.includes(fromStoragePlane(scope.plane)))
      .filter((scope) => input.kinds === undefined || input.kinds.includes(scope.scopeKind as Scope["kind"]))
      .map(toScope);
    return { scopes };
  }

  public async listAuditEvents(input: ListAuditEventsInput = {}): Promise<ListAuditEventsOutput> {
    const events = this.storage
      .listAuditEvents({
        entityId: input.targetId,
        eventType: input.types?.length === 1 ? input.types[0] : undefined,
        limit: 1000
      })
      .filter((event) => input.types === undefined || input.types.includes(event.eventType as AuditEvent["type"]))
      .filter((event) => input.since === undefined || event.createdAt >= input.since)
      .filter((event) => input.until === undefined || event.createdAt <= input.until)
      .map(toAuditEvent);
    return { auditEvents: events };
  }

  public async getMemoryGraph(input: GetMemoryGraphInput = {}): Promise<GetMemoryGraphOutput> {
    const memories = this.storage
      .listMemories({ limit: 1000 })
      .filter((memory) => input.scopeIds === undefined || (memory.scopeId !== null && input.scopeIds.includes(memory.scopeId)));
    const memoryIds = new Set(memories.map((memory) => memory.memoryId));
    const nodes: MemoryGraphNode[] = memories.map((memory) => ({
      id: memory.memoryId,
      kind: "memory",
      label: memory.title,
      plane: fromStoragePlane(memory.plane)
    }));
    if (input.includeEvidence !== false) {
      for (const memory of memories) {
        for (const evidence of this.storage.listEvidence(memory.memoryId)) {
          nodes.push({
            id: evidence.evidenceId,
            kind: "evidence",
            label: evidence.sourceRef,
            plane: fromStoragePlane(memory.plane)
          });
        }
      }
    }
    const scopeIds = new Set(memories.map((memory) => memory.scopeId).filter((id): id is string => id !== null));
    for (const scope of this.storage.listScopes().filter((scope) => scopeIds.has(scope.scopeId))) {
      nodes.push({
        id: scope.scopeId,
        kind: "scope",
        label: scope.scopeRef,
        plane: fromStoragePlane(scope.plane)
      });
    }

    const edges: MemoryGraphEdge[] = [];
    for (const memory of memories) {
      if (memory.scopeId !== null) {
        edges.push({
          id: `scope:${memory.scopeId}:${memory.memoryId}`,
          from: memory.scopeId,
          to: memory.memoryId,
          kind: "contains",
          reason: "Scope contains memory."
        });
      }
      for (const evidence of this.storage.listEvidence(memory.memoryId)) {
        edges.push({
          id: `evidence:${evidence.evidenceId}:${memory.memoryId}`,
          from: memory.memoryId,
          to: evidence.evidenceId,
          kind: "supported-by",
          reason: "Evidence supports durable memory."
        });
      }
    }
    for (const edge of this.storage.listMemoryEdges()) {
      if (memoryIds.has(edge.fromMemoryId) && memoryIds.has(edge.toMemoryId)) {
        edges.push(toGraphEdge(edge));
      }
    }
    const graph: MemoryGraph = {
      nodes,
      edges,
      generatedAt: nowIso()
    };
    return { graph };
  }

  public async getContextPack(input: GetContextPackInput): Promise<GetContextPackOutput> {
    const pack = this.storage.getContextPack(input.contextPackId);
    if (pack === null) {
      throw new RuntimeError("NOT_FOUND", `Context pack ${input.contextPackId} was not found.`);
    }
    return { contextPack: this.toContextPack(pack) };
  }

  public async listSessionViolations(
    input: ListSessionViolationsInput = {}
  ): Promise<ListSessionViolationsOutput> {
    if (input.sessionId === undefined) {
      return { violations: [] };
    }
    const violations = this.storage
      .listSessionViolations(input.sessionId)
      .filter((violation) => input.kinds === undefined || input.kinds.includes(violation.violationType as AgentContractViolation["kind"]))
      .filter((violation) => !input.unresolvedOnly || violation.resolvedAt === null)
      .map(toViolation);
    return { violations };
  }

  public async acceptMemory(input: GovernMemoryInput): Promise<GovernMemoryOutput> {
    return this.govern(input, "accepted", "active", "memory.accepted");
  }

  public async rejectMemory(input: GovernMemoryInput): Promise<GovernMemoryOutput> {
    return this.govern(input, "rejected", "rejected", "memory.rejected");
  }

  public async retireMemory(input: GovernMemoryInput): Promise<GovernMemoryOutput> {
    return this.govern(input, "retired", "retired", "memory.retired");
  }

  public async markSensitive(
    input: GovernMemoryInput & { policy?: SensitivityPolicy }
  ): Promise<GovernMemoryOutput> {
    requireReason(input.reason);
    const current = this.requireMemory(input.memoryId);
    const metadata = asJsonObject(current.metadata);
    const contract = asJsonObject(metadata.contract);
    const updated = this.storage.updateMemory(current.memoryId, {
      sensitivity: "sensitive",
      metadata: asStorageJson({
        ...metadata,
        contract: {
          ...contract,
          sensitivity: input.policy ?? { level: "sensitive", reason: input.reason }
        }
      })
    });
    const auditEvent = this.addAuditEvent({
      type: "memory.sensitive_marked",
      targetType: "memory",
      targetId: input.memoryId,
      actor: input.actor,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs
    });
    return { memory: this.toMemoryObject(updated), auditEvent };
  }

  public async exportBundle(input: ExportBundleInput = {}): Promise<ExportBundleOutput> {
    const memories = (await this.listMemories({ planes: input.planes, scopeIds: input.scopeIds })).memories
      .filter((memory) => memory.sensitivity?.retention !== "do-not-export")
      .map((memory) => sanitizeMemoryForRead(memory, "export"));
    const memoryIds = new Set(memories.map((memory) => memory.id));
    const scopeIds = new Set(memories.map((memory) => memory.scopeId));
    const redactedMemoryIds = new Set(
      memories
        .filter((memory) => memory.sensitivity?.retention === "redact-on-export")
        .map((memory) => memory.id)
    );
    const evidence = (await this.listEvidence()).evidence
      .filter((item) => {
        const memoryId = evidenceMemoryId(item);
        return memoryId === undefined || memoryIds.has(memoryId);
      })
      .map((item) => redactEvidenceForExport(item, redactedMemoryIds));
    const evidenceIds = new Set(evidence.map((item) => item.id));
    const scopes = (await this.listScopes({ planes: input.planes })).scopes
      .filter((scope) => scopeIds.has(scope.id));
    const graph = filterGraphForExport((await this.getMemoryGraph({ scopeIds: input.scopeIds })).graph, {
      memoryIds,
      evidenceIds,
      scopeIds
    });
    const contextPacks = input.includeSessions
      ? this.storage
          .listContextPacks({ limit: 1000 })
          .map((contextPack) => filterContextPackForExport(this.toContextPack(contextPack), memoryIds))
          .filter((contextPack) => contextPack.included.length > 0 || contextPack.excluded.length > 0)
      : undefined;
    const contextPackIds = new Set((contextPacks ?? []).map((contextPack) => contextPack.id));
    const sessions = input.includeSessions
      ? this.storage
          .listMemorySessions(1000)
          .map((session) => filterSessionForExport(this.toMemorySession(session), memoryIds, contextPackIds))
          .filter((session) =>
            session.deliveredMemoryIds.length > 0 ||
            session.usedMemoryIds.length > 0 ||
            session.skippedMemoryIds.length > 0 ||
            session.unverifiableMemoryIds.length > 0 ||
            (session.contextPackId !== undefined && contextPackIds.has(session.contextPackId))
          )
      : undefined;
    const sessionIds = new Set((sessions ?? []).map((session) => session.id));
    const auditEvents = (await this.listAuditEvents()).auditEvents
      .filter((event) => auditEventAllowedInExport(event, {
        memoryIds,
        evidenceIds,
        scopeIds,
        contextPackIds,
        sessionIds,
        filtered: input.scopeIds !== undefined || input.planes !== undefined
      }));
    const bundle: ExportBundle = validateExportBundle({
      schemaVersion: EXPORT_BUNDLE_SCHEMA_VERSION,
      exportedAt: nowIso(),
      scopes,
      memories,
      evidence,
      auditEvents,
      sessions,
      contextPacks,
      graph
    });
    this.addAuditEvent({
      type: "bundle.exported",
      targetType: "bundle",
      targetId: `bundle:${bundle.exportedAt}`,
      actor: "runtime",
      reason: `Exported ${bundle.memories.length} memories.`
    });
    return { bundle };
  }

  public async importBundle(input: ImportBundleInput): Promise<ImportBundleOutput> {
    const bundle = validateExportBundle(input.bundle);
    if (input.mode === "replace") {
      throw new RuntimeError("IMPORT_REPLACE_UNSUPPORTED", "Replace import is not supported by the local prototype.");
    }
    if (input.mode === "preview") {
      return {
        importedMemoryIds: bundle.memories.map((memory) => memory.id),
        importedEvidenceIds: bundle.evidence.map((evidence) => evidence.id),
        auditEvent: this.previewAuditEvent("bundle.imported", "bundle", "preview", "Preview import only."),
        previewOnly: true
      };
    }

    const result = this.storage.transaction(() => {
      for (const scope of bundle.scopes) {
        if (this.storage.getScope(scope.id) === null && isDayOnePlane(scope.plane)) {
          this.storage.createScope({
            scopeId: scope.id,
            plane: toStoragePlane(scope.plane),
            scopeKind: scope.kind,
            scopeRef: scope.identity,
            parentScopeId: scope.parentId,
            metadata: scope.metadata ?? {},
            createdAt: bundle.exportedAt
          });
        }
      }
      const importedMemoryIds: string[] = [];
      const importedEvidenceIds: string[] = [];
      for (const memory of bundle.memories) {
        if (this.storage.getMemory(memory.id) === null) {
          const evidence = bundle.evidence.filter((item) => memory.evidenceIds.includes(item.id));
          const validation = this.validateIngest({ memory, evidence });
          if (validation.reasons.length > 0 || validation.memory === undefined || validation.evidence === undefined) {
            throw new RuntimeError("VALIDATION_FAILED", validation.reasons.join("; "));
          }
          this.persistMemory(validation.memory, validation.evidence);
          importedMemoryIds.push(memory.id);
          importedEvidenceIds.push(...memory.evidenceIds);
        }
      }
      const auditEvent = this.addAuditEvent({
        type: "bundle.imported",
        targetType: "bundle",
        targetId: `bundle:${bundle.exportedAt}`,
        actor: "runtime",
        reason: `Imported ${importedMemoryIds.length} new memories; skipped ${bundle.memories.length - importedMemoryIds.length} existing memories.`
      });
      return { importedMemoryIds, importedEvidenceIds, auditEvent };
    });
    return {
      importedMemoryIds: result.importedMemoryIds,
      importedEvidenceIds: result.importedEvidenceIds,
      auditEvent: result.auditEvent,
      previewOnly: false
    };
  }

  public async backup(input: BackupInput): Promise<BackupOutput> {
    const result = await this.storage.backupTo(input.path);
    const auditEvent = this.addAuditEvent({
      type: "bundle.exported",
      targetType: "bundle",
      targetId: result.operationId,
      actor: "runtime",
      reason: `SQLite backup written to ${input.path}.`
    });
    return { path: input.path, auditEvent };
  }

  private govern(
    input: GovernMemoryInput,
    governanceState: MemoryGovernanceState,
    lifecycleState: "active" | "rejected" | "retired",
    auditType: AuditEvent["type"]
  ): GovernMemoryOutput {
    requireReason(input.reason);
    const current = this.requireMemory(input.memoryId);
    const updated = this.storage.updateMemory(current.memoryId, {
      governanceState,
      lifecycleState
    });
    const auditEvent = this.addAuditEvent({
      type: auditType,
      targetType: "memory",
      targetId: input.memoryId,
      actor: input.actor,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs
    });
    return { memory: this.toMemoryObject(updated), auditEvent };
  }

  private ensureScope(memory: MemoryObject): void {
    if (this.storage.getScope(memory.scopeId) !== null) {
      return;
    }
    const scope: Scope = validateScope({
      id: memory.scopeId,
      plane: memory.plane,
      kind: memory.plane === "global-personal" ? "global" : "project",
      name: memory.scopeId,
      identity: memory.scopeId
    });
    this.storage.createScope({
      scopeId: scope.id,
      plane: toStoragePlane(scope.plane),
      scopeKind: scope.kind,
      scopeRef: scope.identity,
      parentScopeId: scope.parentId,
      metadata: scope.metadata ?? {}
    });
  }

  private toMemoryObject(record: MemoryRecord): MemoryObject {
    const metadata = asJsonObject(record.metadata);
    const contract = asJsonObject(metadata.contract);
    const evidenceIds = this.storage.listEvidence(record.memoryId).map((evidence) => evidence.evidenceId);
    const durability = evidenceIds.length === 0 ? "draft" : contract.durability ?? "durable";
    const memory = validateMemoryObject({
      id: record.memoryId,
      plane: fromStoragePlane(record.plane),
      scopeId: record.scopeId ?? "global",
      kind: contract.kind ?? "fact",
      durability,
      lifecycle: fromStorageLifecycle(record),
      content: {
        summary: record.title,
        body: record.body
      },
      facets: Array.isArray(contract.facets) ? contract.facets : [],
      source: sourceRefFromMemory(record),
      evidenceIds,
      confidence: typeof contract.confidence === "number" ? contract.confidence : 0.8,
      strength: record.strength,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      tags: Array.isArray(contract.tags) ? contract.tags.filter((tag): tag is string => typeof tag === "string") : [],
      supersedes: Array.isArray(contract.supersedes)
        ? contract.supersedes.filter((id): id is string => typeof id === "string")
        : [],
      sensitivity:
        record.sensitivity === "sensitive"
          ? (contract.sensitivity as SensitivityPolicy | undefined) ?? { level: "sensitive" }
          : (contract.sensitivity as SensitivityPolicy | undefined) ?? { level: "none" }
    });
    return memory;
  }

  private toMemorySession(record: MemorySessionRecord): MemorySession {
    const usageEvents = this.storage.listMemoryUsageEvents({ sessionId: record.sessionId, limit: 1000 });
    const delivered = idsForUsageState(usageEvents, "delivered");
    const used = idsForUsageState(usageEvents, "used");
    const skipped = idsForUsageState(usageEvents, "skipped");
    const unverifiable = idsForUsageState(usageEvents, "unverifiable");
    const metadata = asJsonObject(record.metadata);
    const agent = asJsonObject(metadata.agent);
    return validateMemorySession({
      id: record.sessionId,
      agent: {
        kind: record.agentKind,
        client: typeof agent.client === "string" ? agent.client : undefined,
        version: record.clientVersion ?? undefined
      },
      mode: record.mode,
      host: record.hostRef ?? undefined,
      project: record.projectRef ?? undefined,
      workspace: record.workspaceRef ?? undefined,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? undefined,
      contextPackId: record.contextPackId ?? undefined,
      usageState: normalizeUsageState(record.usageState),
      ingestState: normalizeIngestState(record.postRunIngestState),
      deliveredMemoryIds: delivered,
      usedMemoryIds: used.filter((id) => delivered.includes(id)),
      skippedMemoryIds: skipped.filter((id) => delivered.includes(id)),
      unverifiableMemoryIds: unverifiable.filter((id) => delivered.includes(id)),
      violationSummary: this.violationSummaryForSession(record.sessionId)
    });
  }

  private toContextPack(record: ContextPackRecord): ContextPack {
    return validateContextPack({
      id: record.contextPackId,
      sessionId: record.sessionId ?? undefined,
      requestId: record.requestId ?? undefined,
      query: record.queryText,
      planePolicy: "all-day-one",
      recallPolicyVersion: record.recallPolicyVersion,
      createdAt: record.createdAt,
      included: record.entries.map((entry): ContextPackEntry => {
        const memory = this.requireMemory(entry.memoryId);
        return {
          id: entry.entryId,
          memoryId: entry.memoryId,
          plane: fromStoragePlane(entry.memoryPlane),
          rank: entry.rank,
          score: entry.score,
          reason: entry.reason,
          recommendedUse: entry.usageRecommendation,
          evidenceRefs: this.evidenceRefsForMemory(entry.memoryId),
          sourceRef: sourceRefFromMemory(memory),
          flags: {
            stale: entry.isStale,
            sensitive: entry.isSensitive,
            conflicted: entry.hasConflict
          }
        };
      }),
      excluded: record.exclusions
        .filter((exclusion) => exclusion.memoryId !== null)
        .map((exclusion): RecallExclusion => ({
          id: exclusion.exclusionId,
          memoryId: exclusion.memoryId ?? "",
          plane: fromStoragePlane(exclusion.sourcePlane),
          reason: exclusion.reason,
          evidenceRefs:
            exclusion.evidenceId === null ? [{ evidenceId: `unknown:${exclusion.exclusionId}` }] : [{ evidenceId: exclusion.evidenceId }],
          lifecycle: normalizeLifecycle(exclusion.lifecycleState ?? "candidate"),
          conflictWithMemoryId: exclusion.conflictRef ?? undefined,
          supersededByMemoryId: exclusion.supersededByMemoryId ?? undefined
        })),
      totalIncludedCount: record.entries.length,
      totalExcludedCount: record.exclusions.filter((exclusion) => exclusion.memoryId !== null).length,
      explanationSummary: record.explanationSummary
    });
  }

  private evidenceRefsForMemory(memoryId: string): EvidenceRef[] {
    const evidence = this.storage.listEvidence(memoryId);
    if (evidence.length === 0) {
      return [{ evidenceId: `missing:${memoryId}` }];
    }
    return evidence.map((item) => ({
      evidenceId: item.evidenceId,
      sourceId: item.sourceType + ":" + item.sourceRef
    }));
  }

  private toPublicEvidence(record: EvidenceRecord, purpose: "read" | "export"): Evidence {
    const evidence = toEvidence(record);
    const memory = this.storage.getMemory(record.memoryId);
    if (memory === null) {
      return evidence;
    }
    const publicMemory = this.toMemoryObject(memory);
    if (
      (purpose === "read" && publicMemory.sensitivity?.retention === "do-not-export") ||
      (purpose === "export" && publicMemory.sensitivity?.retention === "redact-on-export")
    ) {
      return {
        ...evidence,
        summary: "Evidence redacted by sensitivity policy.",
        payload: { memoryId: record.memoryId, redacted: true }
      };
    }
    return evidence;
  }

  private requireMemory(memoryId: string): MemoryRecord {
    const memory = this.storage.getMemory(memoryId);
    if (memory === null) {
      throw new RuntimeError("NOT_FOUND", `Memory ${memoryId} was not found.`);
    }
    return memory;
  }

  private requireSession(sessionId: string): MemorySessionRecord {
    const session = this.storage.getMemorySession(sessionId);
    if (session === null) {
      throw new RuntimeError("NOT_FOUND", `Memory session ${sessionId} was not found.`);
    }
    return session;
  }

  private addAuditEvent(input: {
    readonly type: AuditEvent["type"];
    readonly targetType: AuditEvent["target"]["type"];
    readonly targetId: string;
    readonly actor: string;
    readonly reason: string;
    readonly evidenceRefs?: EvidenceRef[];
  }): AuditEvent {
    const record = this.storage.addAuditEvent({
      eventType: input.type,
      entityType: input.targetType,
      entityId: input.targetId,
      actorRef: input.actor,
      payload: asStorageJson({
        reason: input.reason,
        evidenceRefs: input.evidenceRefs ?? []
      })
    });
    return toAuditEvent(record);
  }

  private previewAuditEvent(
    type: AuditEvent["type"],
    targetType: AuditEvent["target"]["type"],
    targetId: string,
    reason: string
  ): AuditEvent {
    return {
      id: `preview:${cryptoRandomId()}`,
      type,
      at: nowIso(),
      actor: "runtime",
      target: { type: targetType, id: targetId },
      reason
    };
  }

  private violationSummaryForSession(sessionId: string): MemorySession["violationSummary"] {
    const summary = { blocking: 0, important: 0, niceToHave: 0 };
    for (const violation of this.storage.listSessionViolations(sessionId)) {
      if (violation.severity === "error") {
        summary.blocking += 1;
      } else if (violation.severity === "warning") {
        summary.important += 1;
      } else {
        summary.niceToHave += 1;
      }
    }
    return summary;
  }
}

export function createSoulMemoryRuntime(options: SoulMemoryRuntimeOptions = {}): SoulMemoryRuntime {
  return new SoulMemoryRuntime(options);
}

function toStoragePlane(plane: ContractMemoryPlane): StorageMemoryPlane {
  if (plane === "global-personal") return "global_personal";
  if (plane === "project-local") return "project_local";
  throw new RuntimeError("UNSUPPORTED_PLANE", `Memory plane '${plane}' is not supported by this prototype.`);
}

function fromStoragePlane(plane: StorageMemoryPlane): ContractMemoryPlane {
  return plane === "global_personal" ? "global-personal" : "project-local";
}

function isDayOnePlane(plane: ContractMemoryPlane): boolean {
  return plane === "global-personal" || plane === "project-local";
}

function toStorageLifecycle(lifecycle: MemoryLifecycle): "active" | "rejected" | "retired" {
  if (lifecycle === "rejected") return "rejected";
  if (lifecycle === "retired") return "retired";
  return "active";
}

function toStorageGovernance(lifecycle: MemoryLifecycle): MemoryGovernanceState {
  if (lifecycle === "accepted") return "accepted";
  if (lifecycle === "rejected") return "rejected";
  if (lifecycle === "retired") return "retired";
  return "pending";
}

function fromStorageLifecycle(memory: MemoryRecord): MemoryLifecycle {
  if (memory.lifecycleState === "rejected" || memory.governanceState === "rejected") return "rejected";
  if (memory.lifecycleState === "retired" || memory.governanceState === "retired") return "retired";
  if (memory.governanceState === "accepted") return "accepted";
  if (memory.sensitivity === "sensitive") return "sensitive";
  const contract = asJsonObject(asJsonObject(memory.metadata).contract);
  return normalizeLifecycle(typeof contract.lifecycle === "string" ? contract.lifecycle : "candidate");
}

function normalizeLifecycle(value: string): MemoryLifecycle {
  if (
    value === "candidate" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "retired" ||
    value === "superseded" ||
    value === "sensitive"
  ) {
    return value;
  }
  return "candidate";
}

function toPlanePolicy(planes: readonly string[] | undefined): ContextPack["planePolicy"] {
  if (planes === undefined || planes.length === 0) return "all-day-one";
  if (planes.length === 1 && planes[0] === "global-personal") return "global-only";
  if (planes.length === 1 && planes[0] === "project-local") return "project-only";
  return "explicit";
}

function memoryToMetadata(memory: MemoryObject): Record<string, unknown> {
  return {
    contract: {
      kind: memory.kind,
      durability: memory.durability,
      lifecycle: memory.lifecycle,
      facets: memory.facets,
      tags: memory.tags ?? [],
      confidence: memory.confidence,
      evidenceIds: memory.evidenceIds,
      source: memory.source,
      sensitivity: memory.sensitivity,
      supersedes: memory.supersedes ?? []
    }
  };
}

function toEvidence(record: EvidenceRecord): Evidence {
  return validateEvidence({
    id: record.evidenceId,
    type: "operator-statement",
    source: {
      id: record.sourceType + ":" + record.sourceRef,
      type: record.sourceType,
      ref: record.sourceRef
    },
    summary: evidenceSummary(record),
    payload: {
      ...asJsonObject(record.payload),
      memoryId: record.memoryId
    },
    createdAt: record.createdAt,
    confidence: 1
  });
}

function toScope(record: ScopeRecord): Scope {
  return validateScope({
    id: record.scopeId,
    plane: fromStoragePlane(record.plane),
    kind: record.scopeKind,
    name: record.scopeRef,
    identity: record.scopeRef,
    parentId: record.parentScopeId ?? undefined,
    metadata: asJsonObject(record.metadata)
  });
}

function toAuditEvent(record: AuditEventRecord): AuditEvent {
  const payload = asJsonObject(record.payload);
  const evidenceRefs = Array.isArray(payload.evidenceRefs)
    ? payload.evidenceRefs.filter(isEvidenceRef)
    : [];
  return {
    id: record.auditEventId,
    type: record.eventType as AuditEvent["type"],
    at: record.createdAt,
    actor: record.actorRef ?? "runtime",
    target: {
      type: record.entityType as AuditEvent["target"]["type"],
      id: record.entityId
    },
    reason: typeof payload.reason === "string" ? payload.reason : record.eventType,
    evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
    changes: asContractJsonRecord(payload)
  };
}

function toGraphEdge(record: MemoryEdgeRecord): MemoryGraphEdge {
  const metadata = asJsonObject(record.metadata);
  return {
    id: record.edgeId,
    from: record.fromMemoryId,
    to: record.toMemoryId,
    kind: graphEdgeKind(record.edgeType),
    reason: typeof metadata.reason === "string" ? metadata.reason : record.edgeType
  };
}

function toViolation(record: import("../storage/index.js").AgentContractViolationRecord): AgentContractViolation {
  return {
    id: record.violationId,
    sessionId: record.sessionId ?? "unknown-session",
    kind: record.violationType as AgentContractViolation["kind"],
    severity:
      record.severity === "error"
        ? "blocking"
        : record.severity === "warning"
          ? "important"
          : "nice-to-have",
    at: record.createdAt,
    message: record.summary,
    resolvedAt: record.resolvedAt ?? undefined
  };
}

function sanitizeMemoryForRead(memory: MemoryObject, purpose: "read" | "export"): MemoryObject {
  const retention = memory.sensitivity?.retention;
  if (retention !== "redact-on-export" && retention !== "do-not-export") {
    return memory;
  }
  if (purpose === "export" && retention === "redact-on-export") {
    return redactMemory(memory, "Sensitive memory redacted for export.");
  }
  if (purpose === "read" && retention === "do-not-export") {
    return redactMemory(memory, "Sensitive memory hidden by retention policy.");
  }
  return memory;
}

function redactMemory(memory: MemoryObject, summary: string): MemoryObject {
  return {
    ...memory,
    content: {
      summary,
      body: summary
    },
    facets: [],
    tags: memory.tags?.filter((tag) => tag === "sensitive") ?? []
  };
}

function redactEvidenceForExport(evidence: Evidence, redactedMemoryIds: ReadonlySet<string>): Evidence {
  const memoryId = evidenceMemoryId(evidence);
  if (memoryId === undefined || !redactedMemoryIds.has(memoryId)) {
    return evidence;
  }
  return {
    ...evidence,
    summary: "Evidence redacted for export.",
    payload: { memoryId, redacted: true }
  };
}

function filterGraphForExport(
  graph: MemoryGraph,
  allowed: {
    readonly memoryIds: ReadonlySet<string>;
    readonly evidenceIds: ReadonlySet<string>;
    readonly scopeIds: ReadonlySet<string>;
  }
): MemoryGraph {
  const nodes = graph.nodes.filter((node) => {
    if (node.kind === "memory") return allowed.memoryIds.has(node.id);
    if (node.kind === "evidence") return allowed.evidenceIds.has(node.id);
    if (node.kind === "scope") return allowed.scopeIds.has(node.id);
    return false;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  };
}

function filterContextPackForExport(contextPack: ContextPack, memoryIds: ReadonlySet<string>): ContextPack {
  const included = contextPack.included.filter((entry) => memoryIds.has(entry.memoryId));
  const excluded = contextPack.excluded.filter((entry) => memoryIds.has(entry.memoryId));
  return validateContextPack({
    ...contextPack,
    included,
    excluded,
    totalIncludedCount: included.length,
    totalExcludedCount: excluded.length
  });
}

function filterSessionForExport(
  session: MemorySession,
  memoryIds: ReadonlySet<string>,
  contextPackIds: ReadonlySet<string>
): MemorySession {
  const deliveredMemoryIds = session.deliveredMemoryIds.filter((id) => memoryIds.has(id));
  const usedMemoryIds = session.usedMemoryIds.filter((id) => memoryIds.has(id));
  const skippedMemoryIds = session.skippedMemoryIds.filter((id) => memoryIds.has(id));
  const unverifiableMemoryIds = session.unverifiableMemoryIds.filter((id) => memoryIds.has(id));
  return validateMemorySession({
    ...session,
    contextPackId:
      session.contextPackId !== undefined && contextPackIds.has(session.contextPackId)
        ? session.contextPackId
        : undefined,
    deliveredMemoryIds,
    usedMemoryIds,
    skippedMemoryIds,
    unverifiableMemoryIds
  });
}

function auditEventAllowedInExport(
  event: AuditEvent,
  allowed: {
    readonly memoryIds: ReadonlySet<string>;
    readonly evidenceIds: ReadonlySet<string>;
    readonly scopeIds: ReadonlySet<string>;
    readonly contextPackIds: ReadonlySet<string>;
    readonly sessionIds: ReadonlySet<string>;
    readonly filtered: boolean;
  }
): boolean {
  if (event.target.type === "memory") return allowed.memoryIds.has(event.target.id);
  if (event.target.type === "evidence") return allowed.evidenceIds.has(event.target.id);
  if (event.target.type === "scope") return allowed.scopeIds.has(event.target.id);
  if (event.target.type === "context-pack") return allowed.contextPackIds.has(event.target.id);
  if (event.target.type === "session") return allowed.sessionIds.has(event.target.id);
  return !allowed.filtered;
}

function toRecallExclusion(
  memory: MemoryRecord,
  reason: string,
  evidenceRefs: EvidenceRef[]
): RecallExclusion {
  return {
    id: `exclusion:${memory.memoryId}`,
    memoryId: memory.memoryId,
    plane: fromStoragePlane(memory.plane),
    reason,
    evidenceRefs,
    lifecycle: fromStorageLifecycle(memory)
  };
}

function sourceRefFromMemory(memory: MemoryRecord): SourceRef {
  const contract = asJsonObject(asJsonObject(memory.metadata).contract);
  const source = asJsonObject(contract.source);
  return {
    id: typeof source.id === "string" ? source.id : memory.sourceType + ":" + memory.sourceRef,
    type: typeof source.type === "string" ? source.type : memory.sourceType,
    ref: typeof source.ref === "string" ? source.ref : memory.sourceRef,
    actor: typeof source.actor === "string" ? source.actor : undefined,
    observedAt: typeof source.observedAt === "string" ? source.observedAt : undefined
  } as SourceRef;
}

function scoreMemory(query: string, memory: MemoryRecord): number {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const text = `${memory.title} ${memory.body}`.toLowerCase();
  if (terms.length === 0) return 0.5;
  const hits = terms.filter((term) => text.includes(term)).length;
  return Number(Math.min(1, 0.35 + hits / terms.length).toFixed(3));
}

function recallReason(query: string, memory: MemoryRecord): string {
  return `Lexical recall matched '${query}' against ${memory.plane} memory '${memory.title}'.`;
}

function normalizeUsageState(value: string): MemorySession["usageState"] {
  if (
    value === "not-delivered" ||
    value === "delivered" ||
    value === "used" ||
    value === "skipped" ||
    value === "unverifiable" ||
    value === "mixed"
  ) {
    return value;
  }
  if (value === "pending") return "not-delivered";
  return "mixed";
}

function normalizeIngestState(value: string): MemorySession["ingestState"] {
  if (
    value === "not-requested" ||
    value === "requested" ||
    value === "previewed" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "skipped" ||
    value === "failed"
  ) {
    return value;
  }
  if (value === "completed") return "accepted";
  if (value === "pending") return "not-requested";
  return "requested";
}

function idsForUsageState(
  events: readonly MemoryUsageEventRecord[],
  state: "delivered" | "used" | "skipped" | "unverifiable"
): string[] {
  return [
    ...new Set(
      events
        .filter((event) => event.memoryId !== null)
        .filter((event) => {
          const payload = asJsonObject(event.payload);
          return payload.state === state || event.eventType.includes(state);
        })
        .map((event) => event.memoryId ?? "")
    )
  ];
}

function idsForProvenUsage(events: readonly MemoryUsageEventRecord[]): string[] {
  return [
    ...new Set(
      events
        .filter((event) => event.memoryId !== null)
        .filter((event) => {
          const payload = asJsonObject(event.payload);
          return (payload.state === "used" || event.eventType.includes("used")) &&
            event.proofRef !== null &&
            event.proofRef.trim().length > 0;
        })
        .map((event) => event.memoryId ?? "")
    )
  ];
}

function evidenceMemoryId(evidence: Evidence): string | undefined {
  const payload = asJsonObject(evidence.payload);
  return typeof payload.memoryId === "string" ? payload.memoryId : undefined;
}

function evidenceSummary(record: EvidenceRecord): string {
  const payload = asJsonObject(record.payload);
  if (typeof payload.summary === "string") return payload.summary;
  if (typeof payload.quote === "string") return payload.quote;
  return `Evidence from ${record.sourceType}:${record.sourceRef}`;
}

function graphEdgeKind(edgeType: string): MemoryGraphEdge["kind"] {
  if (edgeType === "supports") return "supported-by";
  if (edgeType === "derives_from") return "derived-from";
  if (edgeType === "contradicts") return "conflicts-with";
  if (edgeType === "supersedes") return "supersedes";
  if (edgeType === "used-in") return "used-in";
  return "recalled-in";
}

function requireReason(reason: string): void {
  if (reason.trim().length === 0) {
    throw new RuntimeError("VALIDATION_FAILED", "Governance actions require a reason.");
  }
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStorageJson(value: unknown): StorageJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as StorageJsonValue;
}

function asContractJsonRecord(value: unknown): Record<string, ContractJsonValue> {
  const normalized = JSON.parse(JSON.stringify(value ?? {})) as ContractJsonValue;
  if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
    return normalized;
  }
  return {};
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  return (
    value !== null &&
    typeof value === "object" &&
    "evidenceId" in value &&
    typeof (value as { evidenceId?: unknown }).evidenceId === "string"
  );
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultDataPath(): string {
  return process.env.SOUL_MEMORY_DATA ?? "var/soul-memory.db";
}

export function createDefaultRuntime(): SoulMemoryRuntime {
  return createSoulMemoryRuntime({ path: defaultDataPath() });
}

export function runtimeStorageExists(path: string): boolean {
  return path === ":memory:" || existsSync(path);
}
