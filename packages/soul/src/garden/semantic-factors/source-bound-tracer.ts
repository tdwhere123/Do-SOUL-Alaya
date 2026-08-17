import {
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraphProposal
} from "@do-soul/alaya-protocol";
import {
  assertSourceBoundF3SealCurrent,
  SOURCE_BOUND_F3_FORBIDDEN_WRITES,
  type SourceBoundF3Capability
} from "./source-bound-seal.js";

export interface SourceBoundF3Trace {
  readonly capability: SourceBoundF3Capability;
  readonly accepted_identities: readonly string[];
  readonly rejected: readonly string[];
  readonly invented_surface_rate: number;
  readonly membership_identities: readonly string[];
  readonly used_topology: boolean;
  readonly physical_calls: 0;
}

export function traceSourceBoundF3Proposal(input: {
  readonly sourceText: string;
  readonly capability: SourceBoundF3Capability;
  readonly proposal: OpenSemanticFactorGraphProposal | null;
  readonly rawProposal?: unknown;
}): SourceBoundF3Trace {
  assertSourceBoundF3SealCurrent();
  const forbidden = forbiddenWrites(input.rawProposal ?? input.proposal);
  if (forbidden.length > 0) {
    return finished(input.capability, [], forbidden, 0, false);
  }
  if (input.capability === "f0_f2_only") {
    return finished(input.capability, [], [], 0, false);
  }
  if (input.proposal === null) {
    return finished(input.capability, [], ["empty_or_missing_proposal"], 0, false);
  }
  return traceProposal(input.sourceText, input.capability, input.proposal);
}

function traceProposal(
  sourceText: string,
  capability: SourceBoundF3Capability,
  proposal: OpenSemanticFactorGraphProposal
): SourceBoundF3Trace {
  const invented = proposal.factors.filter((factor) =>
    !surfaceOccurs(sourceText, factor.surface, factor.source_occurrence ?? 0)
  );
  const accepted = proposal.factors
    .filter((factor) => !invented.includes(factor))
    .map((factor) => factor.semantic_identity);
  const inventedRate = proposal.factors.length === 0
    ? 0
    : invented.length / proposal.factors.length;
  if (capability === "identities_only") {
    return finished(
      capability,
      accepted,
      invented.map((factor) => `invented_surface:${factor.surface}`),
      inventedRate,
      false
    );
  }
  const grounded = groundOpenSemanticFactorGraph(proposal, sourceText);
  if (grounded === null || grounded.propositions.length === 0) {
    return finished(
      capability,
      [],
      [...invented.map((factor) => `invented_surface:${factor.surface}`), "topology_ungrounded"],
      inventedRate,
      true
    );
  }
  return finished(
    capability,
    grounded.factors.map((factor) => factor.semantic_identity),
    invented.map((factor) => `invented_surface:${factor.surface}`),
    inventedRate,
    true
  );
}

function finished(
  capability: SourceBoundF3Capability,
  accepted: readonly string[],
  rejected: readonly string[],
  inventedRate: number,
  usedTopology: boolean
): SourceBoundF3Trace {
  return {
    capability,
    accepted_identities: accepted,
    rejected,
    invented_surface_rate: inventedRate,
    membership_identities: capability === "f0_f2_only" ? [] : accepted,
    used_topology: usedTopology,
    physical_calls: 0
  };
}

function surfaceOccurs(sourceText: string, surface: string, occurrence: number): boolean {
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = sourceText.indexOf(surface, from);
    if (found < 0) return false;
    from = found + 1;
  }
  return true;
}

function forbiddenWrites(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null) return [];
  return SOURCE_BOUND_F3_FORBIDDEN_WRITES.filter((key) => key in value);
}
