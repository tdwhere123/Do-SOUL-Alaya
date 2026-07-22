import {
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { buildGardenTurnEvidenceArtifactRef } from "@do-soul/alaya-soul";

export interface PostTurnSignalReceiveResult {
  readonly signal: Readonly<{
    readonly signal_id: string;
    readonly workspace_id: string;
  }>;
  readonly materialization?: Readonly<{
    readonly created_objects: readonly Readonly<{
      readonly object_kind: string;
      readonly object_id: string;
    }>[];
  }> | null;
}

export interface PostTurnSignalReceiver {
  receiveSignal(signal: CandidateMemorySignal): Promise<PostTurnSignalReceiveResult>;
  hasCreatedEvidence(result: PostTurnSignalReceiveResult): Promise<boolean>;
}

export function receivedEvidenceCapsule(result: PostTurnSignalReceiveResult): boolean {
  return result.materialization?.created_objects.some(
    (created) => created.object_kind === "evidence_capsule"
  ) ?? false;
}

export function createPostTurnSignalReceiver(
  receiver: Pick<PostTurnSignalReceiver, "receiveSignal">,
  eventLookup: Readonly<{
    queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  }>,
  evidenceLookup: Readonly<{
    findByArtifactRef(workspaceId: string, artifactRef: string): Promise<unknown | null>;
  }>
): PostTurnSignalReceiver {
  return {
    receiveSignal: (signal) => receiver.receiveSignal(signal),
    hasCreatedEvidence: async (result) => await durableEvidenceExists(
      result,
      eventLookup,
      evidenceLookup
    )
  };
}

async function durableEvidenceExists(
  result: PostTurnSignalReceiveResult,
  eventLookup: Parameters<typeof createPostTurnSignalReceiver>[1],
  evidenceLookup: Parameters<typeof createPostTurnSignalReceiver>[2]
): Promise<boolean> {
  if (receivedEvidenceCapsule(result)) return true;
  if (await materializationEventCreatedEvidence(eventLookup, result.signal.signal_id)) return true;
  return await evidenceLookup.findByArtifactRef(
    result.signal.workspace_id,
    buildGardenTurnEvidenceArtifactRef(result.signal.signal_id)
  ) !== null;
}

async function materializationEventCreatedEvidence(
  eventLookup: Readonly<{
    queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  }>,
  signalId: string
): Promise<boolean> {
  const events = await eventLookup.queryByEntity("candidate_memory_signal", signalId);
  return events.some((event) => eventCreatedEvidence(event));
}

function eventCreatedEvidence(event: EventLogEntry): boolean {
  if (event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED) return false;
  const parsed = SoulSignalMaterializedPayloadSchema.safeParse(event.payload_json);
  return parsed.success && parsed.data.success && parsed.data.created_objects.some(
    (created) => created.object_kind === "evidence_capsule"
  );
}
