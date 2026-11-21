import {
  EvidenceCapsuleSchema,
  EvidenceSearchProjectionSchema,
  CommittedObjectError,
  MemoryGovernanceEventType,
  SoulEvidenceCreatedPayloadSchema,
  type EvidenceCapsule,
  type EvidenceSearchProjection,
  type EventLogEntry,
  type SourceAdmissionPort
} from "@do-soul/alaya-protocol";
import type { EvidenceCapsuleInput, EvidenceServiceEvidenceCapsuleRepoPort } from "../evidence-service.js";
import { CoreError } from "../../shared/errors.js";
import {
  appendEventLogSynchronously,
  EventLogSyncAppendRequiredError
} from "../../runtime/event-publisher.js";
import { runEventLogTransaction } from "../memory-service/memory-audit-append.js";
import { admitEvidenceSource } from "./admit-evidence-source.js";
import type { FieldFormationStores } from "./field-stores.js";
import { appendSourceRecordAdmitted } from "./source-admission-audit.js";
import {
  SOURCE_ENRICHMENT_CONTRACT,
  admitSourceEnrichmentIntent,
  type SourceWriteGardenIntentPort
} from "../source-write-garden-intent.js";

// Core-private capability: derived provenance excerpts are not new source bodies.
// Keep this out of the package-root exports and all serialized contracts.
export const SOURCE_PROVENANCE_CAPSULE = Symbol("source provenance capsule");

type EvidenceCreateInput = Readonly<{
  readonly assertSourceCurrent?: () => void;
  readonly sourceProvenance?: typeof SOURCE_PROVENANCE_CAPSULE;
  readonly capsuleInput: EvidenceCapsuleInput;
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
  readonly evidenceCapsuleRepo: Pick<EvidenceServiceEvidenceCapsuleRepoPort, "createInCurrentTransaction">;
  readonly eventLogRepo: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
    transactional?<T>(fn: () => T): T;
  };
  readonly runtimeNotifier: {
    notifyEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly generateObjectId: () => string;
  readonly now: () => string;
  readonly sourceAdmission: SourceAdmissionPort;
  readonly fieldStores: FieldFormationStores;
  readonly gardenIntentPort?: SourceWriteGardenIntentPort;
  readonly projectionLifecycle?: Readonly<{
    requestRebuild(workspaceId: string, requestedAt: string): void;
    drainPending(): void;
  }>;
  readonly enqueueEnrichment?: {
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  };
}>;

export async function createEvidenceCapsule(input: EvidenceCreateInput): Promise<Readonly<EvidenceCapsule>> {
  const timestamp = input.now();
  const evidence = parseCreatedCapsule(input, timestamp);
  const projections = parseSearchProjections(input, evidence.object_id);
  const enqueueEnrichment = freezeEvidenceEnrichmentIntent(input.enqueueEnrichment);
  if (enqueueEnrichment !== undefined && input.gardenIntentPort === undefined) {
    throw new CoreError(
      "CONFLICT",
      "Atomic enrichment enqueue requested but no Garden intent port is wired."
    );
  }
  const { event, created } = persistCreatedEvidence(input, evidence, projections, enqueueEnrichment);
  if (input.sourceProvenance !== SOURCE_PROVENANCE_CAPSULE) {
    await admitOptionalEvidenceSource(input, created);
  }
  try {
    input.projectionLifecycle?.drainPending();
  } catch (error) {
    // A valid capsule survives optional projection failure; its transactional
    // rebuild intent remains available to checkpoint/startup recovery.
    input.warn?.("optional evidence projection failed", {
      evidence_object_id: created.object_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    await input.runtimeNotifier.notifyEntry(event);
  } catch (cause) {
    throw new CommittedObjectError("Evidence was committed but runtime notification failed.", {
      object_kind: created.object_kind, object_id: created.object_id
    }, { cause });
  }
  return created;
}

function parseCreatedCapsule(input: EvidenceCreateInput, timestamp: string): EvidenceCapsule {
  const { object_id: reservedObjectId, ...capsuleInput } = input.capsuleInput;
  try {
    return EvidenceCapsuleSchema.parse({
      ...capsuleInput,
      object_id: reservedObjectId ?? input.generateObjectId(),
      object_kind: "evidence_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp
    });
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid evidence capsule payload", { cause: error });
  }
}

function parseSearchProjections(input: EvidenceCreateInput, evidenceId: string): readonly EvidenceSearchProjection[] {
  try {
    const projections = input.searchProjections.map((projection) => EvidenceSearchProjectionSchema.parse(projection));
    if (projections.some(({ projection_kind }) => projection_kind === "fact_key")) {
      throw new CoreError("VALIDATION", "Fact-key projections are not accepted on evidence creation");
    }
    return projections;
  } catch (error) {
    input.warn?.("optional evidence search projections rejected", {
      evidence_object_id: evidenceId,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

async function admitOptionalEvidenceSource(input: EvidenceCreateInput, evidence: EvidenceCapsule): Promise<void> {
  try {
    const admitted = admitEvidenceSource(evidence, input.sourceAdmission, input.fieldStores);
    await appendSourceRecordAdmitted(input.eventLogRepo, admitted, input.runtimeNotifier);
  } catch (error) {
    input.warn?.("optional evidence source admission failed", {
      evidence_object_id: evidence.object_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function persistCreatedEvidence(
  input: EvidenceCreateInput,
  evidence: EvidenceCapsule,
  projections: readonly EvidenceSearchProjection[],
  enqueueEnrichment: EvidenceCreateInput["enqueueEnrichment"]
): { readonly event: EventLogEntry; readonly created: Readonly<EvidenceCapsule> } {
  const createInCurrentTransaction = input.evidenceCapsuleRepo.createInCurrentTransaction;
  if (createInCurrentTransaction === undefined) {
    throw new CoreError("CONFLICT", "Evidence create transaction port is not available", {
      subCode: "PORT_UNAVAILABLE"
    });
  }
  return runEventLogTransaction(
    input.eventLogRepo,
    () => {
      input.assertSourceCurrent?.();
      const event = appendCreatedSynchronously(input.eventLogRepo, evidence);
      const created = createInCurrentTransaction.call(
        input.evidenceCapsuleRepo,
        evidence,
        projections,
        input.sourceProvenance === SOURCE_PROVENANCE_CAPSULE
      );
      if (enqueueEnrichment !== undefined && input.gardenIntentPort !== undefined) {
        admitSourceEnrichmentIntent(input.gardenIntentPort, {
          workspaceId: created.workspace_id,
          sourceObjectId: created.object_id,
          sourceRevision: event.revision,
          enrichmentContract: SOURCE_ENRICHMENT_CONTRACT,
          runId: enqueueEnrichment.runId,
          createdAt: created.created_at
        });
      }
      // Even provenance-only capsules participate in the governance frontier.
      // Optional source formation cannot own this already committed obligation.
      input.projectionLifecycle?.requestRebuild(created.workspace_id, created.created_at);
      return { event, created };
    },
    "Evidence create requires a transactional EventLog port"
  );
}

function appendCreatedSynchronously(
  eventLogRepo: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  },
  evidence: EvidenceCapsule
): EventLogEntry {
  try {
    return appendEventLogSynchronously(eventLogRepo, {
      event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
      entity_type: "evidence_capsule",
      entity_id: evidence.object_id,
      workspace_id: evidence.workspace_id,
      run_id: evidence.run_id,
      caused_by: evidence.created_by,
      payload_json: SoulEvidenceCreatedPayloadSchema.parse({
        object_id: evidence.object_id,
        object_kind: evidence.object_kind,
        workspace_id: evidence.workspace_id,
        run_id: evidence.run_id
      })
    });
  } catch (error) {
    if (error instanceof EventLogSyncAppendRequiredError) {
      throw new CoreError(
        "CONFLICT",
        "Evidence create transaction requires a synchronous EventLog append port.",
        { cause: error }
      );
    }
    throw error;
  }
}


function freezeEvidenceEnrichmentIntent(
  intent: { readonly runId: string | null; readonly sourceSignalId: string | null } | undefined
): { readonly runId: string | null; readonly sourceSignalId: string | null } | undefined {
  if (intent === undefined) {
    return undefined;
  }
  return Object.freeze({
    runId: intent.runId,
    sourceSignalId: intent.sourceSignalId
  });
}
