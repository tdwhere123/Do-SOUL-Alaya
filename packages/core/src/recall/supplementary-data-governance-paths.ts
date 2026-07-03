import {
  isPathRecallEligible,
  type ManifestationState,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { errorNameOf, toErrorMessage } from "./recall-service-helpers.js";
import type {
  PathInflowEdge,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";
import {
  GOVERNANCE_CEILING_FAILSAFE_BAND,
  memoryGovernanceCeiling,
  type PathGovernanceContribution
} from "../path-graph/path-manifestation-policy.js";
import { anchorMemoryId, buildPathInflowByTarget } from "./path-relations.js";

// invariant: governance_class is a hard ceiling on recall manifestation; absent path expansion is fail-open, path read failure is fail-closed to the safe hint band.
// The same anchor-keyed PathRelation load also yields the conformant path-flood inflow adjacency (zero extra DB).
export async function collectGovernancePathDerivations(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "pathExpansionPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
}): Promise<Readonly<{
  readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
  readonly pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
}>> {
  const pathExpansionPort = params.dependencies.pathExpansionPort;
  if (pathExpansionPort === undefined || params.candidates.length === 0) {
    return Object.freeze({ governanceCeilingByMemoryId: Object.freeze({}), pathInflowByTarget: Object.freeze({}) });
  }
  const candidateIds = new Set(params.candidates.map((candidate) => candidate.object_id));
  const anchors = buildGovernanceCandidateAnchors(candidateIds);
  let paths: readonly Readonly<PathRelation>[];
  try {
    paths = await pathExpansionPort.findByAnchors(params.workspaceId, anchors);
  } catch (error) {
    params.warn("governance ceiling path lookup failed", {
      workspace_id: params.workspaceId,
      candidate_count: params.candidates.length,
      operation: "governance_ceiling_path_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return Object.freeze({
      governanceCeilingByMemoryId: buildGovernanceFailsafeCeilings(candidateIds),
      pathInflowByTarget: Object.freeze({})
    });
  }
  const contributionsByMemoryId = collectGovernanceContributions(paths, candidateIds);
  return Object.freeze({
    governanceCeilingByMemoryId: buildGovernanceCeilingByMemoryId(contributionsByMemoryId),
    pathInflowByTarget: Object.freeze(buildPathInflowByTarget(paths, candidateIds))
  });
}

function buildGovernanceCandidateAnchors(
  candidateIds: ReadonlySet<string>
): readonly PathAnchorRef[] {
  return [...candidateIds].map((object_id) => ({ kind: "object", object_id }));
}

function buildGovernanceFailsafeCeilings(
  candidateIds: ReadonlySet<string>
): Readonly<Record<string, ManifestationState>> {
  // fail-closed: cap every candidate to the safe band so a transient read error cannot lift a governed memory to full strength.
  const failsafeCeilings: Record<string, ManifestationState> = {};
  for (const object_id of candidateIds) {
    failsafeCeilings[object_id] = GOVERNANCE_CEILING_FAILSAFE_BAND;
  }
  return Object.freeze(failsafeCeilings);
}

function collectGovernanceContributions(
  paths: readonly Readonly<PathRelation>[],
  candidateIds: ReadonlySet<string>
): ReadonlyMap<string, PathGovernanceContribution[]> {
  const contributionsByMemoryId = new Map<string, PathGovernanceContribution[]>();
  for (const path of paths) {
    const targetMemoryId = resolveGovernedTargetMemoryId(path, candidateIds);
    if (targetMemoryId === undefined) {
      continue;
    }
    const contribution: PathGovernanceContribution = {
      governance_class: path.legitimacy.governance_class,
      evidence_basis: path.legitimacy.evidence_basis
    };
    const contributions = contributionsByMemoryId.get(targetMemoryId);
    if (contributions === undefined) {
      contributionsByMemoryId.set(targetMemoryId, [contribution]);
    } else {
      contributions.push(contribution);
    }
  }
  return contributionsByMemoryId;
}

function resolveGovernedTargetMemoryId(
  path: Readonly<PathRelation>,
  candidateIds: ReadonlySet<string>
): string | undefined {
  if (!isPathRecallEligible(path)) {
    return undefined;
  }
  // invariant: the ceiling is inbound — keyed on the path's target memory; source-anchor paths govern their target, not the candidate.
  const targetMemoryId = anchorMemoryId(path.anchors.target_anchor);
  if (targetMemoryId === undefined || !candidateIds.has(targetMemoryId)) {
    return undefined;
  }
  return targetMemoryId;
}

function buildGovernanceCeilingByMemoryId(
  contributionsByMemoryId: ReadonlyMap<string, readonly PathGovernanceContribution[]>
): Readonly<Record<string, ManifestationState>> {
  const ceilingByMemoryId: Record<string, ManifestationState> = {};
  for (const [memoryId, contributions] of contributionsByMemoryId) {
    ceilingByMemoryId[memoryId] = memoryGovernanceCeiling(contributions);
  }
  return Object.freeze(ceilingByMemoryId);
}
