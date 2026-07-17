import { randomUUID } from "node:crypto";
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
  scheduleAuditedAsyncSideEffect
} from "@do-soul/alaya-core";
import type {
  PathRelationProposalPayload,
  TemporalRelationAssertionPort as SoulTemporalRelationAssertionPort
} from "@do-soul/alaya-soul";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";

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
  | "proposalRepo"
  | "relationAssertionRepo"
  | "runtimeNotifier"
  | "temporalProjectionSelected"
  | "warn"
>;

export function createPathRelationRuntime(input: PathRelationRuntimeInput): Readonly<{
  readonly pathRelationProposalService: PathRelationProposalService;
  readonly pathRelationProposalPort: PathRelationProposalPort;
  readonly temporalRelationAssertionPort: TemporalRelationAssertionPort;
  readonly pathRelationEvictionTimer: NodeJS.Timeout;
}> {
  const runtimeConfig = readPathRelationRuntimeConfig();
  const pathRelationProposalService = createPathRelationProposalService(input, runtimeConfig);
  const pathRelationEvictionTimer = createPathRelationEvictionTimer(
    input,
    pathRelationProposalService,
    runtimeConfig.counterTtlMs
  );
  const pathRelationProposalPort = createPathRelationProposalPort(input);
  const temporalRelationAssertionPort = createTemporalRelationAssertionPort(input);
  return Object.freeze({
    pathRelationProposalService,
    pathRelationProposalPort,
    temporalRelationAssertionPort,
    pathRelationEvictionTimer
  });
}

function createTemporalRelationAssertionPort(
  input: Pick<PathRelationRuntimeInput, "eventLogRepo" | "eventPublisher" | "relationAssertionRepo">
): TemporalRelationAssertionPort {
  const service = new RelationAssertionService({
    repo: input.relationAssertionRepo,
    eventPublisher: input.eventPublisher,
    eventHistory: input.eventLogRepo
  });
  return {
    admit: async (admission) => {
      const result = await service.admit({
        workspaceId: admission.workspaceId,
        runId: admission.runId,
        causedBy: "garden",
        evidenceIds: admission.evidenceIds,
        anchors: admission.anchors,
        relationKind: admission.relationKind,
        validity: admission.validity,
        sourceEventAnchor: {
          eventType: admission.sourceEventAnchor.event_type,
          eventId: admission.sourceEventAnchor.event_id,
          occurredAt: admission.sourceEventAnchor.occurred_at
        }
      });
      return {
        object_kind: "relation_assertion",
        object_id: result.assertion.assertion_id
      };
    }
  };
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
    | "warn"
  >,
  runtimeConfig: ReturnType<typeof readPathRelationRuntimeConfig>
) {
  return new PathRelationProposalService({
    repo: {
      create: (relation) => input.pathRelationRepo.create(relation),
      findByAnchorMemoryId: async (memoryId, workspaceId) =>
        await input.pathRelationRepo.findByBackingObjectId(workspaceId, memoryId)
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
