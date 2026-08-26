import { randomUUID } from "node:crypto";
import {
  EvidenceHealthStateSchema,
  MemoryGovernanceEventType,
  SoulEvidenceHealthChangedPayloadSchema,
  TransitionCausedBySchema,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationProposal,
  type EvidenceSearchProjection,
  type EvidenceHealthState,
  type EventLogEntry,
  type FactorIncidencePort,
  type FieldContractSha256,
  type OpenSemanticFactorFormationAdmission,
  type OpenSemanticFactorFormationCapture,
  type SourceAdmissionPort,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import type { OpenSemanticFactorExtractionPort } from
  "../semantic/open-semantic-factor-extraction-port.js";
import { CoreError } from "../shared/errors.js";
import { parseObjectId } from "../shared/validators.js";
import { createEvidenceCapsule } from "./evidence-create/create-evidence.js";
import { createFactorIncidencePort } from "./evidence-create/factor-incidence.js";
import { fieldContractSha256 } from "../shared/field-hash.js";
import {
  appendEventLogSynchronously,
  EventLogSyncAppendRequiredError
} from "../runtime/event-publisher.js";
import { runEventLogTransaction } from "./memory-service/memory-audit-append.js";
import {
  createInMemoryFieldStores,
  type FieldFormationStores
} from "./evidence-create/field-stores.js";
import { createSourceAdmissionPort } from "./evidence-create/source-admission.js";
import type { EvidenceFactFrameProposalNormalizer } from
  "./fact-frame-formation/declarative-normalizer.js";

const evidenceHealthTransitions: Readonly<Record<EvidenceHealthState, readonly EvidenceHealthState[]>> = {
  verified: ["questionable", "degraded", "broken"],
  questionable: ["verified", "degraded", "broken"],
  degraded: ["verified", "questionable", "broken"],
  broken: ["degraded"]
};

export type EvidenceCapsuleInput = Omit<
  EvidenceCapsule,
  "object_id" | "object_kind" | "schema_version" | "lifecycle_state" | "created_at" | "updated_at"
>;

export interface EvidenceServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  transactional?<T>(fn: () => T): T;
}

export interface EvidenceListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface EvidenceServiceEvidenceCapsuleRepoPort {
  create(
    capsule: EvidenceCapsule,
    searchProjections?: readonly Readonly<EvidenceSearchProjection>[],
    factFrameFormation?: Readonly<EvidenceFactFrameFormationCapture>,
    semanticFactorFormation?: Readonly<OpenSemanticFactorFormationCapture>
    , semanticCompleteness?: Readonly<import("@do-soul/alaya-protocol")
      .EvidenceOsfSemanticCompletenessReceipt>
  ): Promise<Readonly<EvidenceCapsule>>;
  createInCurrentTransaction?(
    capsule: EvidenceCapsule,
    searchProjections?: readonly Readonly<EvidenceSearchProjection>[],
    factFrameFormation?: Readonly<EvidenceFactFrameFormationCapture>,
    semanticFactorFormation?: Readonly<OpenSemanticFactorFormationCapture>
    , semanticCompleteness?: Readonly<import("@do-soul/alaya-protocol")
      .EvidenceOsfSemanticCompletenessReceipt>
  ): Readonly<EvidenceCapsule>;
  deleteById(objectId: string): Promise<void>;
  findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null>;
  findByIds?(workspaceId: string, objectIds: readonly string[]): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByRunIdPage?(
    runId: string,
    page: EvidenceListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceIdPage?(
    workspaceId: string,
    page: EvidenceListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealthPage?(
    health: EvidenceHealthState,
    page: EvidenceListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]>;
  updateHealth(
    objectId: string,
    health: EvidenceHealthState,
    updatedAt: string
  ): Promise<Readonly<EvidenceCapsule>>;
  updateHealthInCurrentTransaction?(
    objectId: string,
    health: EvidenceHealthState,
    updatedAt: string
  ): Readonly<EvidenceCapsule>;
}

export interface EvidenceRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

// invariant: see also: DynamicsService.emitKarmaEvent — the
// evidence_gain karma kind fires from transitionHealth on the
// questionable -> verified edge so the memory bound to the evidence
// gets a retention bump when the source becomes trustworthy again.
export interface EvidenceServiceKarmaEmitterPort {
  emitKarmaEvent(input: {
    readonly kind: "evidence_gain";
    readonly objectId: string;
    readonly workspaceId: string;
    // evidence promotion fires from transitionHealth with no run
    // context in hand, so this stays unset; the field exists to keep
    // the emitter contract uniform with the run-bearing producers.
    readonly runId?: string | null;
  }): Promise<void>;
}

export interface EvidenceServiceMemoryRefLookupPort {
  findMemoriesByEvidenceRef(
    evidenceObjectId: string,
    workspaceId: string
  ): Promise<readonly { readonly object_id: string }[]>;
}

export interface EvidenceServiceDependencies {
  readonly evidenceCapsuleRepo: EvidenceServiceEvidenceCapsuleRepoPort;
  readonly eventLogRepo: EvidenceServiceEventLogRepoPort;
  readonly runtimeNotifier: EvidenceRuntimeNotifier;
  readonly karmaEmitter?: EvidenceServiceKarmaEmitterPort;
  readonly memoryRefLookup?: EvidenceServiceMemoryRefLookupPort;
  readonly factFrameProposalNormalizer?:
    Readonly<EvidenceFactFrameProposalNormalizer> | null;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
  readonly sha256?: FieldContractSha256;
  readonly sourceAdmission?: SourceAdmissionPort;
  readonly factorIncidence?: FactorIncidencePort;
  readonly fieldStores?: FieldFormationStores;
  readonly semanticExtractor?: OpenSemanticFactorExtractionPort;
  readonly projectionLifecycle?: Readonly<{
    requestRebuild(workspaceId: string, requestedAt: string): void;
    drainPending(): void;
  }>;
}

export class EvidenceService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;
  private readonly sha256: FieldContractSha256;
  private readonly fieldStores: FieldFormationStores;
  private readonly sourceAdmission: SourceAdmissionPort;
  private readonly factorIncidence: FactorIncidencePort;

  public constructor(private readonly dependencies: EvidenceServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sha256 = dependencies.sha256 ?? fieldContractSha256;
    this.fieldStores = dependencies.fieldStores ?? createInMemoryFieldStores();
    this.sourceAdmission = dependencies.sourceAdmission ?? createSourceAdmissionPort({
      sha256: this.sha256,
      stores: this.fieldStores
    });
    this.factorIncidence = dependencies.factorIncidence ?? createFactorIncidencePort({
      sha256: this.sha256,
      stores: this.fieldStores
    });
  }

  public async create(
    input: EvidenceCapsuleInput,
    searchProjections: readonly Readonly<EvidenceSearchProjection>[] = [],
    factFrameProposal?: Readonly<EvidenceFactFrameFormationProposal>,
    semanticFactorProposal?: Readonly<OpenSemanticFactorFormationAdmission>
  ): Promise<Readonly<EvidenceCapsule>> {
    return await createEvidenceCapsule({
      capsuleInput: input,
      searchProjections,
      factFrameProposal,
      semanticFactorProposal,
      evidenceCapsuleRepo: this.dependencies.evidenceCapsuleRepo,
      eventLogRepo: this.dependencies.eventLogRepo,
      runtimeNotifier: this.dependencies.runtimeNotifier,
      factFrameProposalNormalizer: this.dependencies.factFrameProposalNormalizer,
      warn: this.dependencies.warn,
      generateObjectId: this.generateObjectId,
      now: this.now,
      sha256: this.sha256,
      sourceAdmission: this.sourceAdmission,
      factorIncidence: this.factorIncidence,
      fieldStores: this.fieldStores,
      semanticExtractor: this.dependencies.semanticExtractor
    });
  }

  public async transitionHealth(
    objectId: string,
    newHealth: EvidenceHealthState,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<EvidenceCapsule>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedHealth = parseEvidenceHealthState(newHealth);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const existing = await this.dependencies.evidenceCapsuleRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Evidence not found");
    }

    ensureValidHealthTransition(existing.evidence_health_state, parsedHealth);

    const occurredAt = this.now();
    const { event, updated } = persistHealthTransition(
      this.dependencies,
      existing,
      parsedHealth,
      parsedReason,
      parsedCausedBy,
      occurredAt
    );

    this.dependencies.projectionLifecycle?.requestRebuild(updated.workspace_id, occurredAt);
    this.dependencies.projectionLifecycle?.drainPending();

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    await this.emitEvidenceGainIfPromoted({
      fromHealth: existing.evidence_health_state,
      toHealth: parsedHealth,
      evidenceObjectId: updated.object_id,
      workspaceId: updated.workspace_id
    });
    return updated;
  }

  private async emitEvidenceGainIfPromoted(input: {
    readonly fromHealth: EvidenceHealthState;
    readonly toHealth: EvidenceHealthState;
    readonly evidenceObjectId: string;
    readonly workspaceId: string;
  }): Promise<void> {
    if (input.fromHealth !== "questionable" || input.toHealth !== "verified") {
      return;
    }
    const karmaEmitter = this.dependencies.karmaEmitter;
    const memoryRefLookup = this.dependencies.memoryRefLookup;
    if (karmaEmitter === undefined || memoryRefLookup === undefined) {
      return;
    }
    let memories: readonly { readonly object_id: string }[] = [];
    try {
      memories = await memoryRefLookup.findMemoriesByEvidenceRef(
        input.evidenceObjectId,
        input.workspaceId
      );
    } catch (error) {
      this.dependencies.warn?.("evidence_gain memory lookup failed", {
        evidence_object_id: input.evidenceObjectId,
        workspace_id: input.workspaceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    for (const memory of memories) {
      try {
        await karmaEmitter.emitKarmaEvent({
          kind: "evidence_gain",
          objectId: memory.object_id,
          workspaceId: input.workspaceId
        });
      } catch (error) {
        this.dependencies.warn?.("evidence_gain karma emit failed", {
          memory_object_id: memory.object_id,
          workspace_id: input.workspaceId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  public findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null> {
    return this.dependencies.evidenceCapsuleRepo.findById(objectId);
  }

  public async findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    const findByIds = this.dependencies.evidenceCapsuleRepo.findByIds;
    if (findByIds === undefined) {
      const rows = await Promise.all(
        [...new Set(objectIds)].map(async (objectId) => {
          const row = await this.dependencies.evidenceCapsuleRepo.findById(objectId);
          return row === null || row.workspace_id !== workspaceId ? null : row;
        })
      );
      return rows.filter((row): row is Readonly<EvidenceCapsule> => row !== null);
    }
    return await findByIds.call(this.dependencies.evidenceCapsuleRepo, workspaceId, objectIds);
  }

  // SECURITY: scoped lookup blocks cross-workspace pointer resolution at
  // the service layer (parallel to MemoryService.findByIdScoped). Used by
  // soul.open_pointer to dereference evidence_refs back to raw turn
  // material without leaking foreign-workspace evidence.
  public async findByIdScoped(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<EvidenceCapsule> | null> {
    const evidence = await this.dependencies.evidenceCapsuleRepo.findById(objectId);
    if (evidence === null || evidence.workspace_id !== workspaceId) {
      return null;
    }
    return evidence;
  }

  public findByRunId(
    runId: string,
    page?: EvidenceListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    if (page !== undefined) {
      const findByRunIdPage = this.dependencies.evidenceCapsuleRepo.findByRunIdPage;
      if (findByRunIdPage === undefined) {
        throw new CoreError("CONFLICT", "Evidence repository does not support paged run listing");
      }
      return findByRunIdPage.call(this.dependencies.evidenceCapsuleRepo, runId, page);
    }
    return this.dependencies.evidenceCapsuleRepo.findByRunId(runId);
  }

  public findByWorkspaceId(
    workspaceId: string,
    page?: EvidenceListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    if (page !== undefined) {
      const findByWorkspaceIdPage = this.dependencies.evidenceCapsuleRepo.findByWorkspaceIdPage;
      if (findByWorkspaceIdPage === undefined) {
        throw new CoreError("CONFLICT", "Evidence repository does not support paged workspace listing");
      }
      return findByWorkspaceIdPage.call(this.dependencies.evidenceCapsuleRepo, workspaceId, page);
    }
    return this.dependencies.evidenceCapsuleRepo.findByWorkspaceId(workspaceId);
  }

  public findByHealth(
    health: EvidenceHealthState,
    page?: EvidenceListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]> {
    if (page !== undefined) {
      const findByHealthPage = this.dependencies.evidenceCapsuleRepo.findByHealthPage;
      if (findByHealthPage === undefined) {
        throw new CoreError("CONFLICT", "Evidence repository does not support paged health listing");
      }
      return findByHealthPage.call(this.dependencies.evidenceCapsuleRepo, health, page);
    }
    return this.dependencies.evidenceCapsuleRepo.findByHealth(health);
  }
}

function parseEvidenceHealthState(value: EvidenceHealthState): EvidenceHealthState {
  try {
    return EvidenceHealthStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid evidence health state", { cause: error });
  }
}

function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Transition reason is required");
  }

  return value;
}

function parseTransitionCausedBy(value: TransitionCausedBy): TransitionCausedBy {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}

function persistHealthTransition(
  dependencies: EvidenceServiceDependencies,
  existing: Readonly<EvidenceCapsule>,
  parsedHealth: EvidenceHealthState,
  parsedReason: string,
  parsedCausedBy: TransitionCausedBy,
  occurredAt: string
): { readonly event: EventLogEntry; readonly updated: Readonly<EvidenceCapsule> } {
  const updateHealthInCurrentTransaction =
    dependencies.evidenceCapsuleRepo.updateHealthInCurrentTransaction;
  if (updateHealthInCurrentTransaction === undefined) {
    throw new CoreError("CONFLICT", "Evidence health transition transaction port is not available", {
      subCode: "PORT_UNAVAILABLE"
    });
  }
  return runEventLogTransaction(
    dependencies.eventLogRepo,
    () => {
      const event = appendHealthChangedSynchronously(
        dependencies.eventLogRepo,
        existing,
        parsedHealth,
        parsedReason,
        parsedCausedBy,
        occurredAt
      );
      const updated = updateHealthInCurrentTransaction.call(
        dependencies.evidenceCapsuleRepo,
        existing.object_id,
        parsedHealth,
        occurredAt
      );
      return { event, updated };
    },
    "Evidence health transition requires a transactional EventLog port"
  );
}

function appendHealthChangedSynchronously(
  eventLogRepo: EvidenceServiceEventLogRepoPort,
  existing: Readonly<EvidenceCapsule>,
  parsedHealth: EvidenceHealthState,
  parsedReason: string,
  parsedCausedBy: TransitionCausedBy,
  occurredAt: string
): EventLogEntry {
  try {
    return appendEventLogSynchronously(eventLogRepo, {
      event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_HEALTH_CHANGED,
      entity_type: "evidence_capsule",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulEvidenceHealthChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.evidence_health_state,
        to_state: parsedHealth,
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });
  } catch (error) {
    if (error instanceof EventLogSyncAppendRequiredError) {
      throw new CoreError(
        "CONFLICT",
        "Evidence health transition requires a synchronous EventLog append port.",
        { cause: error }
      );
    }
    throw error;
  }
}

function ensureValidHealthTransition(from: EvidenceHealthState, to: EvidenceHealthState): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "Evidence health transition must change state");
  }

  if (!evidenceHealthTransitions[from].includes(to)) {
    throw new CoreError("VALIDATION", `Invalid evidence health transition: ${from} -> ${to}`);
  }
}
