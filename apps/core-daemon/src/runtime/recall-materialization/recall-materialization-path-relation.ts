import { createHash, randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  MemoryGovernanceEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  SoulProposalCreatedPayloadSchema
} from "@do-soul/alaya-protocol";
import {
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  PathRelationProposalService,
  RelationAssertionService,
  type RelationAssertionAdmissionPort,
  scheduleAuditedAsyncSideEffect,
  stableStringify
} from "@do-soul/alaya-core";
import type {
  PathRelationProposalPayload,
  TemporalRelationAssertionPort as SoulTemporalRelationAssertionPort
} from "@do-soul/alaya-soul";
import {
  digestRelationFormationEventSource,
  type RelationFormationEventSource
} from "@do-soul/alaya-storage";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";
import {
  createRelationProjectionModePorts,
  type RelationProjectionCheckpointPort
} from "./relation-projection/checkpoint.js";
import { DEFAULT_RELATION_PROJECTION_ADMISSION_MODE } from "./relation-projection/mode.js";

export type PathRelationProposalPort = {
  assertPathRelationProposalAvailable(input: { readonly workspaceId: string }): Promise<void>;
  createPathRelationProposal(input: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly targetObjectId: string;
    readonly reason: string;
    readonly sourceSignalId: string;
    readonly proposedPathRelation: PathRelationProposalPayload;
  }): Promise<Readonly<{ readonly object_kind: string; readonly object_id: string }>>;
};

export type TemporalRelationAssertionPort = SoulTemporalRelationAssertionPort;

type PathRelationRuntimeInput = Pick<
  CreateRecallMaterializationWiringInput,
  | "coUsageCounterRepo"
  | "eventLogRepo"
  | "eventPublisher"
  | "memoryEntryRepo"
  | "pathFailureHealthInboxPort"
  | "pathRelationRepo"
  | "softAssociationPathRepo"
  | "proposalRepo"
  | "relationProjectionAdmissionMode"
  | "relationAssertionRepo"
  | "runtimeNotifier"
  | "warn"
>;

export function createPathRelationRuntime(input: PathRelationRuntimeInput): Readonly<{
  readonly pathRelationProposalService: PathRelationProposalService;
  readonly relationAssertionService: RelationAssertionService;
  readonly relationAssertionAdmissionPort: RelationAssertionAdmissionPort;
  readonly relationProjectionCheckpoint: RelationProjectionCheckpointPort;
  readonly pathRelationProposalPort: PathRelationProposalPort;
  readonly temporalRelationAssertionPort: TemporalRelationAssertionPort;
  readonly pathRelationEvictionTimer: NodeJS.Timeout;
}> {
  const runtimeConfig = readPathRelationRuntimeConfig();
  const relationAssertionService = new RelationAssertionService({
    repo: input.relationAssertionRepo,
    eventPublisher: input.eventPublisher,
    eventHistory: input.eventLogRepo
  });
  const pathRelationProposalService = createPathRelationProposalService(input, runtimeConfig);
  const pathRelationEvictionTimer = createPathRelationEvictionTimer(
    input,
    pathRelationProposalService,
    runtimeConfig.counterTtlMs
  );
  const pathRelationProposalPort = createPathRelationProposalPort(input);
  const admissionMode = input.relationProjectionAdmissionMode ??
    DEFAULT_RELATION_PROJECTION_ADMISSION_MODE;
  const { relationAssertionAdmissionPort, relationProjectionCheckpoint } =
    createRelationProjectionModePorts(
      relationAssertionService,
      admissionMode
    );
  const temporalRelationAssertionPort = createTemporalRelationAssertionPort(
    input,
    relationAssertionAdmissionPort
  );
  return Object.freeze({
    pathRelationProposalService,
    relationAssertionService,
    relationAssertionAdmissionPort,
    relationProjectionCheckpoint,
    pathRelationProposalPort,
    temporalRelationAssertionPort,
    pathRelationEvictionTimer
  });
}

function createTemporalRelationAssertionPort(
  input: Pick<PathRelationRuntimeInput, "eventLogRepo">,
  assertionPort: RelationAssertionAdmissionPort
): TemporalRelationAssertionPort {
  return {
    admit: async (admission) => {
      const sourceEventAnchor = {
        event_type: admission.sourceEventAnchor.event_type,
        event_id: admission.sourceEventAnchor.event_id,
        occurred_at: admission.sourceEventAnchor.occurred_at
      };
      const sourceEvent = (await input.eventLogRepo.queryByEntity(
        "candidate_memory_signal",
        admission.sourceSignalId
      )).find((event) => event.event_id === sourceEventAnchor.event_id);
      if (
        sourceEvent === undefined ||
        sourceEvent.event_type !== sourceEventAnchor.event_type ||
        sourceEvent.entity_type !== "candidate_memory_signal" ||
        sourceEvent.entity_id !== admission.sourceSignalId ||
        sourceEvent.workspace_id !== admission.workspaceId
      ) {
        throw new Error(`Relation source event ${sourceEventAnchor.event_id} does not match its anchor.`);
      }
      const evidenceReceipts = admission.evidenceIds.map((evidenceId) => ({
        evidence_id: evidenceId,
        source_event_anchor: sourceEventAnchor
      }));
      const formationReceipt = buildSignalFormationReceipt({
        sourceEvent,
        evidenceReceipts,
        anchors: admission.anchors,
        relationKind: admission.relationKind,
        validity: admission.validity
      });
      const result = await assertionPort.admit({
        workspaceId: admission.workspaceId,
        runId: admission.runId,
        causedBy: "garden",
        evidenceReceipts,
        formationReceipt,
        anchors: admission.anchors,
        relationKind: admission.relationKind,
        validity: admission.validity
      });
      return {
        object_kind: "relation_assertion",
        object_id: result.assertion.assertion_id
      };
    }
  };
}

function buildSignalFormationReceipt(input: Readonly<{
  readonly sourceEvent: Readonly<RelationFormationEventSource>;
  readonly evidenceReceipts: readonly Readonly<unknown>[];
  readonly anchors: Readonly<unknown>;
  readonly relationKind: string;
  readonly validity: Readonly<unknown>;
}>) {
  const eventSha256 = digestRelationFormationEventSource(input.sourceEvent);
  const operatorId = "signal_relation_assertion_admission_v1";
  const parameters = { relation_kind: input.relationKind };
  const decision = {
    event_sha256: eventSha256,
    evidence_receipts: input.evidenceReceipts,
    anchors: input.anchors,
    relation_kind: input.relationKind,
    validity: input.validity
  };
  return {
    operator_id: operatorId,
    operator_sha256: sha256(`${operatorId}:verified-event-and-evidence-receipts`),
    parameters,
    parameter_sha256: sha256(stableStringify(parameters)),
    source_observations: [{
      source_kind: "event_log_entry" as const,
      source_id: input.sourceEvent.event_id,
      source_sha256: eventSha256
    }],
    decision,
    decision_sha256: sha256(stableStringify(decision))
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readPositiveNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function readPathRelationRuntimeConfig() {
  return {
    counterTtlMs: readPositiveNumberEnv("ALAYA_PATHREL_COUNTER_TTL_MS"),
    threshold: readPositiveIntegerEnv("ALAYA_PATHREL_CO_USAGE_THRESHOLD")
  };
}

function createPathRelationProposalService(
  input: Pick<
    PathRelationRuntimeInput,
    | "coUsageCounterRepo"
    | "eventPublisher"
    | "memoryEntryRepo"
    | "pathFailureHealthInboxPort"
    | "pathRelationRepo"
    | "softAssociationPathRepo"
    | "warn"
  >,
  runtimeConfig: ReturnType<typeof readPathRelationRuntimeConfig>
) {
  return new PathRelationProposalService({
    repo: {
      create: (relation) => relation.constitution.relation_kind === "co_recalled"
        ? input.softAssociationPathRepo.create(relation)
        : input.pathRelationRepo.create(relation),
      findByAnchorMemoryId: async (memoryId, workspaceId, relationKind) =>
        relationKind === "co_recalled"
          ? await input.softAssociationPathRepo.findByBackingObjectId(workspaceId, memoryId)
          : await input.pathRelationRepo.findByBackingObjectId(workspaceId, memoryId)
    },
    counterStore: input.coUsageCounterRepo,
    memoryExistence: {
      workspaceOfObject: async (objectId) => {
        const entry = await input.memoryEntryRepo.findById(objectId);
        return entry === null ? null : entry.workspace_id;
      }
    },
    eventPublisher: input.eventPublisher,
    healthInboxPort: {
      recordPathRelationFailure: (entry) =>
        input.pathFailureHealthInboxPort.recordPathRelationFailure(entry)
    },
    ...(runtimeConfig.counterTtlMs === undefined
      ? {}
      : { counterTtlMs: runtimeConfig.counterTtlMs }),
    ...(runtimeConfig.threshold === undefined ? {} : { threshold: runtimeConfig.threshold }),
    warn: input.warn
  });
}

function createPathRelationEvictionTimer(
  input: Pick<PathRelationRuntimeInput, "eventLogRepo" | "runtimeNotifier">,
  pathRelationProposalService: PathRelationProposalService,
  counterTtlMs: number | undefined
) {
  const timer = setInterval(() => {
    scheduleAuditedAsyncSideEffect(pathRelationProposalService.evictExpired(), {
      source: "core-daemon.recall-materialization",
      operation: "path_relation_counter_eviction",
      subjectType: "path_relation_counter",
      subjectId: "__system__",
      workspaceId: "__system__",
      runId: null,
      warningCode: "ALAYA_PATH_RELATION_COUNTER_EVICTION_FAILED",
      warningMessage: "[RecallMaterialization] PathRelation counter eviction failed",
      eventLogRepo: input.eventLogRepo,
      runtimeNotifier: input.runtimeNotifier
    });
  }, counterTtlMs ?? PATH_RELATION_COUNTER_DEFAULT_TTL_MS);
  timer.unref?.();
  return timer;
}

function createPathRelationProposalPort(
  input: Pick<PathRelationRuntimeInput, "proposalRepo" | "runtimeNotifier">
): PathRelationProposalPort {
  return {
    assertPathRelationProposalAvailable: async (proposalInput) => {
      await input.proposalRepo.countPending(proposalInput.workspaceId);
    },
    createPathRelationProposal: async (proposalInput) =>
      await createPathRelationProposal(input, proposalInput)
  };
}

async function createPathRelationProposal(
  input: Pick<PathRelationRuntimeInput, "proposalRepo" | "runtimeNotifier">,
  proposalInput: Parameters<PathRelationProposalPort["createPathRelationProposal"]>[0]
) {
  const timestamp = new Date().toISOString();
  const proposalId = randomUUID();
  const proposal = buildPathRelationProposalRecord(proposalId, proposalInput, timestamp);
  const created = await input.proposalRepo.createProposalWithEvents(
    {
      proposal,
      workspace_id: proposalInput.workspaceId,
      run_id: proposalInput.runId,
      target_object_kind: "path_relation",
      proposed_change_summary: `${proposalInput.reason} Source signal: ${proposalInput.sourceSignalId}.`,
      proposed_path_relation: proposalInput.proposedPathRelation,
      created_at: timestamp
    },
    [
      {
        event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: proposalInput.workspaceId,
        run_id: proposalInput.runId,
        caused_by: "garden",
        payload_json: SoulProposalCreatedPayloadSchema.parse({
          object_id: proposal.runtime_id,
          object_kind: proposal.object_kind,
          workspace_id: proposalInput.workspaceId,
          run_id: proposalInput.runId
        })
      }
    ]
  );
  await notifyCreatedProposalEvents(input, created.events);
  return {
    object_kind: "proposal",
    object_id: created.proposal.proposal_id
  };
}

function buildPathRelationProposalRecord(
  proposalId: string,
  proposalInput: Parameters<PathRelationProposalPort["createPathRelationProposal"]>[0],
  timestamp: string
) {
  return ProposalSchema.parse({
    runtime_id: proposalId,
    object_kind: ControlPlaneObjectKind.PROPOSAL,
    task_surface_ref: null,
    expires_at: null,
    derived_from: proposalInput.targetObjectId,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: proposalId,
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [
      {
        option_id: `path_relation_${proposalId}`,
        option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: timestamp
  });
}

async function notifyCreatedProposalEvents(
  input: Pick<PathRelationRuntimeInput, "runtimeNotifier">,
  events: readonly Parameters<typeof input.runtimeNotifier.notifyEntry>[0][]
): Promise<void> {
  for (const event of events) {
    await input.runtimeNotifier.notifyEntry(event);
  }
}
