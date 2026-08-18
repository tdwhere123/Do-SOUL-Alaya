import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import type { PinnedProjectionCandidateSelection } from
  "../../field/retrieval/projection/pinned-projection-selection.js";
import type {
  CoarseRecallCandidate,
  RecallServiceWarnPort
} from "../recall-service-types.js";

export function admitFieldProjectionCandidates(
  memories: readonly Readonly<MemoryEntry>[] | undefined,
  selection: PinnedProjectionCandidateSelection | undefined,
  warn: RecallServiceWarnPort
): readonly Readonly<CoarseRecallCandidate>[] {
  const hydrated = memories ?? [];
  const admitted: Array<Readonly<CoarseRecallCandidate>> = [];
  const droppedIds: string[] = [];
  for (const entry of hydrated) {
    const score = fieldProjectionActivation(entry, selection);
    if (score === undefined) {
      droppedIds.push(entry.object_id);
      continue;
    }
    admitted.push(buildFieldProjectionCandidate(entry, score));
  }
  warnFieldProjectionHydrationGaps(hydrated, selection, droppedIds, warn);
  return admitted;
}

function fieldProjectionActivation(
  entry: Readonly<MemoryEntry>,
  selection: PinnedProjectionCandidateSelection | undefined
): number | undefined {
  if (selection === undefined) return undefined;
  const scores = entry.evidence_refs.flatMap((evidenceId) => {
    const score = selection.candidate_activation[evidenceId];
    return score === undefined ? [] : [score];
  });
  return scores.length === 0 ? undefined : Math.max(...scores);
}

function buildFieldProjectionCandidate(
  entry: Readonly<MemoryEntry>,
  activationScore: number
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({
    entry,
    originPlane: "workspace_local",
    sourceChannel: "field_projection",
    sourceChannels: Object.freeze(["field_projection"] as const),
    admissionPlanes: Object.freeze(["activation"] as const),
    firstAdmissionPlane: "activation",
    structuralScore: activationScore
  });
}

function warnFieldProjectionHydrationGaps(
  hydrated: readonly Readonly<MemoryEntry>[],
  selection: PinnedProjectionCandidateSelection | undefined,
  droppedIds: readonly string[],
  warn: RecallServiceWarnPort
): void {
  // Do not add these IDs to public trace; membership stays the JSON/activation predicate.
  const jsonBound = new Set(hydrated.flatMap((entry) => entry.evidence_refs));
  const selectedUnbound = sortedUniqueIds(
    (selection?.candidate_keys ?? []).filter((id) => !jsonBound.has(id))
  );
  const dropped = sortedUniqueIds(droppedIds);
  if (selectedUnbound.length > 0) {
    warn("field projection selected evidence has no hydrated JSON binding", {
      selected_but_unbound: selectedUnbound
    });
  }
  if (dropped.length > 0) {
    warn("field projection hydrated memory omitted by JSON activation binding", {
      hydrated_but_dropped: dropped
    });
  }
}

function sortedUniqueIds(ids: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(ids)].sort(compareText));
}
