import type { PathMintOutcome, SubmitCandidateInput } from "../edge-proposals/path-relation-proposal-service.js";
import { COHERES_WITH_SEED_PROFILE } from "../edge-proposals/path-relation-proposal-service.js";
import { buildSessionMap, sparsifyPairs, splitPairKey } from "./path-pair-sparsify.js";

// Source of object↔object semantic-coherence pairs (cosine ≥ floor, canonical
// `${low}|${high}` keys). Embedding math lives behind this port; the producer
// itself never touches vectors. Satisfied by EmbeddingRecallService.coherentPairKeys.
export interface CoherencePairSourcePort {
  coherentPairKeys(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
    readonly floor: number;
  }): Promise<ReadonlySet<string>>;
}

export interface CoherenceEdgeMintPort {
  submitCandidate(input: SubmitCandidateInput): Promise<PathMintOutcome>;
}

export interface CoherenceEdgeProducerDeps {
  readonly pairSource: CoherencePairSourcePort;
  readonly mintPort: CoherenceEdgeMintPort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export interface CoherenceCrystallizeInput {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly objects: readonly { readonly objectId: string; readonly sessionId?: string | null }[];
  readonly floor: number;
  readonly capPerNode: number;
  readonly crossSessionOnly: boolean;
}

export interface CoherenceCrystallizeResult {
  readonly coherentPairs: number;
  readonly keptPairs: number;
  readonly minted: number;
}

const EMPTY_RESULT: CoherenceCrystallizeResult = Object.freeze({
  coherentPairs: 0,
  keptPairs: 0,
  minted: 0
});

// Design S: crystallize coheres_with edges at formation from object↔object
// cosine. Shared by the production embedding-ready hook and the bench harness so
// both mint via the same truth-boundary path. Sparsified (cross-session + per-node
// cap) so a dense coherent cluster cannot flood the graph.
export class CoherenceEdgeProducerService {
  public constructor(private readonly deps: CoherenceEdgeProducerDeps) {}

  public async crystallize(input: CoherenceCrystallizeInput): Promise<CoherenceCrystallizeResult> {
    if (input.objects.length < 2) {
      return EMPTY_RESULT;
    }
    const objectIds = input.objects.map((object) => object.objectId);
    const sessionById = buildSessionMap(input.objects);
    const coherent = await this.loadCoherentPairs(input, objectIds);
    if (coherent.size === 0) {
      return EMPTY_RESULT;
    }
    const kept = sparsifyPairs(coherent, sessionById, input.capPerNode, input.crossSessionOnly);
    if (kept.size === 0) {
      return Object.freeze({ coherentPairs: coherent.size, keptPairs: 0, minted: 0 });
    }
    const minted = await this.mintCoherentPairs(input, kept);
    return Object.freeze({ coherentPairs: coherent.size, keptPairs: kept.size, minted });
  }

  private async loadCoherentPairs(
    input: CoherenceCrystallizeInput,
    objectIds: readonly string[]
  ): Promise<ReadonlySet<string>> {
    try {
      return await this.deps.pairSource.coherentPairKeys({
        workspaceId: input.workspaceId,
        runId: input.runId,
        objectIds,
        floor: input.floor
      });
    } catch (error) {
      this.deps.warn?.("coherence pair lookup failed", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        error: error instanceof Error ? error.message : String(error)
      });
      return new Set<string>();
    }
  }

  private async mintCoherentPairs(
    input: CoherenceCrystallizeInput,
    kept: ReadonlySet<string>
  ): Promise<number> {
    let minted = 0;
    for (const pairKey of kept) {
      const [low, high] = splitPairKey(pairKey);
      const outcome = await this.deps.mintPort.submitCandidate({
        workspaceId: input.workspaceId,
        sourceAnchor: { kind: "object", object_id: low },
        targetAnchor: { kind: "object", object_id: high },
        relationKind: COHERES_WITH_SEED_PROFILE.relationKind,
        initialStrength: COHERES_WITH_SEED_PROFILE.initialStrength,
        governanceClass: COHERES_WITH_SEED_PROFILE.governanceClass,
        evidenceBasis: COHERES_WITH_SEED_PROFILE.evidenceBasis,
        recallBiasSign: COHERES_WITH_SEED_PROFILE.recallBiasSign,
        recallBiasMagnitude: COHERES_WITH_SEED_PROFILE.recallBiasMagnitude,
        runId: input.runId
      });
      if (outcome === "applied") {
        minted += 1;
      }
    }
    return minted;
  }
}
