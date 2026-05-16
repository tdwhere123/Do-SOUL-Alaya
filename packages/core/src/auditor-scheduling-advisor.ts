import type { PathRelation } from "@do-soul/alaya-protocol";

// invariant: AuditorSchedulingAdvisor reads PathRelation.effect_vector.
// verification_bias and produces a deterministic priority ordering for
// Auditor evidence-recheck queues. Any positive verification_bias
// (strictly greater than zero) lifts the recheck above a peer whose bias
// is zero. The advisor does not enqueue or dispatch — it only orders an
// existing queue handed in by the caller.
// see also: path-activation-candidate-producer.ts (upstream PathRelation reader).
// see also: evidence-service.ts (Auditor downstream).

export interface PathVerificationBiasReaderPort {
  // Returns the maximum verification_bias across all active PathRelation
  // rows anchored on the supplied memory object_id. Implementations are
  // expected to apply PathLifecycleStatus filtering. Returns 0 when no
  // active path references the memory.
  getMaxVerificationBias(workspaceId: string, memoryObjectId: string): Promise<number>;
}

export interface AuditorRecheckCandidate {
  readonly memoryObjectId: string;
  readonly enqueuedAt: string;
}

export interface AuditorRecheckPrioritized extends AuditorRecheckCandidate {
  readonly verificationBias: number;
}

export interface AuditorSchedulingAdvisorDependencies {
  readonly verificationBiasReader: PathVerificationBiasReaderPort;
}

export class AuditorSchedulingAdvisor {
  public constructor(private readonly deps: AuditorSchedulingAdvisorDependencies) {}

  // Sorts a queue of evidence-recheck candidates in descending
  // verification_bias order. Ties resolve by enqueuedAt ascending and
  // then by memoryObjectId for full determinism. Returns a new frozen
  // array; does not mutate the input.
  public async prioritizeRechecksByBias(
    workspaceId: string,
    candidates: readonly Readonly<AuditorRecheckCandidate>[]
  ): Promise<readonly Readonly<AuditorRecheckPrioritized>[]> {
    if (candidates.length === 0) {
      return Object.freeze([]);
    }

    const enriched: Readonly<AuditorRecheckPrioritized>[] = [];
    for (const candidate of candidates) {
      const bias = await this.deps.verificationBiasReader.getMaxVerificationBias(
        workspaceId,
        candidate.memoryObjectId
      );
      enriched.push(
        Object.freeze({
          memoryObjectId: candidate.memoryObjectId,
          enqueuedAt: candidate.enqueuedAt,
          verificationBias: bias
        })
      );
    }

    enriched.sort(compareByBiasDescThenEnqueuedAtAsc);
    return Object.freeze(enriched);
  }
}

function compareByBiasDescThenEnqueuedAtAsc(
  left: Readonly<AuditorRecheckPrioritized>,
  right: Readonly<AuditorRecheckPrioritized>
): number {
  if (right.verificationBias !== left.verificationBias) {
    return right.verificationBias - left.verificationBias;
  }
  if (left.enqueuedAt !== right.enqueuedAt) {
    return left.enqueuedAt.localeCompare(right.enqueuedAt);
  }
  return left.memoryObjectId.localeCompare(right.memoryObjectId);
}

// Helper that derives an in-memory PathVerificationBiasReaderPort over a
// PathRelation lookup port. Useful for tests and for callers that already
// have a richer PathRelation reader at hand.
export interface PathRelationLookupPort {
  findActiveByAnchorObjectIds(
    workspaceId: string,
    memoryObjectIds: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export function createVerificationBiasReaderFromPathLookup(
  lookup: PathRelationLookupPort
): PathVerificationBiasReaderPort {
  return Object.freeze({
    async getMaxVerificationBias(workspaceId: string, memoryObjectId: string): Promise<number> {
      const paths = await lookup.findActiveByAnchorObjectIds(workspaceId, [memoryObjectId]);
      let maxBias = 0;
      for (const path of paths) {
        if (path.lifecycle.status === "retired") {
          continue;
        }
        if (path.effect_vector.verification_bias > maxBias) {
          maxBias = path.effect_vector.verification_bias;
        }
      }
      return maxBias;
    }
  });
}
