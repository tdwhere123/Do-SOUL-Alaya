import {
  CandidateMemorySignalMemoryRefKeys,
  type CandidateMemorySignal,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { resolveStoredSignalEmissionContext } from "@do-soul/alaya-core";
import type { MaterializationRouter } from "@do-soul/alaya-soul";

type SignalEmissionLookup = Parameters<typeof resolveStoredSignalEmissionContext>[0];

type GardenSignalRefReplayInput = Readonly<{
  eventLogRepo: SignalEmissionLookup["eventLogRepo"];
  evidenceCapsuleLookup: Readonly<{
    findByIds(
      workspaceId: string,
      objectIds: readonly string[]
    ): Promise<readonly Readonly<Pick<EvidenceCapsule, "object_id" | "event_anchor">>[]>;
  }>;
  materializationRouter: Pick<MaterializationRouter, "replaySignalRefs">;
}>;

// invariant: replay may reuse a persisted signal only after its unique,
// canonical admission event restores the trusted observation anchor.
export function createGardenSignalRefReplayPort(input: GardenSignalRefReplayInput) {
  return Object.freeze({
    replaySignalRefs: async ({ newMemoryId, memoryEvidenceIds, signal }: {
      readonly newMemoryId: string;
      readonly memoryEvidenceIds: readonly string[];
      readonly signal: CandidateMemorySignal;
    }): Promise<void> => {
      if (!hasReplayableSignalMemoryRefs(signal, newMemoryId)) {
        return;
      }
      const context = await resolveStoredSignalEmissionContext({ eventLogRepo: input.eventLogRepo }, signal);
      if (context === null || context.source_event_anchor === null) {
        throw new Error(
          "BULK_ENRICH signal-ref replay deferred because the canonical signal emission anchor is unavailable."
        );
      }
      const evidenceId = await resolveUniqueReplayEvidenceId({
        evidenceCapsuleLookup: input.evidenceCapsuleLookup,
        workspaceId: signal.workspace_id,
        memoryEvidenceIds,
        sourceEventAnchor: context.source_event_anchor
      });
      if (evidenceId === null) {
        throw new Error(
          "BULK_ENRICH signal-ref replay deferred because the materialized memory has no uniquely anchored evidence capsule."
        );
      }
      await input.materializationRouter.replaySignalRefs({
        newObjectId: newMemoryId,
        evidenceId,
        signal,
        context
      });
    }
  });
}

function hasReplayableSignalMemoryRefs(signal: CandidateMemorySignal, newMemoryId: string): boolean {
  return CandidateMemorySignalMemoryRefKeys.some((key) => signal[key].some((ref) => ref !== newMemoryId));
}

async function resolveUniqueReplayEvidenceId(input: Readonly<{
  evidenceCapsuleLookup: GardenSignalRefReplayInput["evidenceCapsuleLookup"];
  workspaceId: string;
  memoryEvidenceIds: readonly string[];
  sourceEventAnchor: NonNullable<Awaited<ReturnType<typeof resolveStoredSignalEmissionContext>>>["source_event_anchor"];
}>): Promise<string | null> {
  const candidateIds = [...new Set(
    input.memoryEvidenceIds.map((evidenceId) => evidenceId.trim()).filter(Boolean)
  )];
  if (candidateIds.length === 0) {
    return null;
  }
  const candidates = await input.evidenceCapsuleLookup.findByIds(input.workspaceId, candidateIds);
  const matches = candidates.filter((candidate) =>
    candidate.event_anchor !== null &&
    candidate.event_anchor.event_type === input.sourceEventAnchor!.event_type &&
    candidate.event_anchor.event_id === input.sourceEventAnchor!.event_id &&
    candidate.event_anchor.occurred_at === input.sourceEventAnchor!.occurred_at
  );
  return matches.length === 1 ? matches[0]!.object_id : null;
}
