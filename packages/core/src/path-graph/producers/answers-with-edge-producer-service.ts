import type { PathMintOutcome, SubmitCandidateInput } from "../edge-proposals/path-relation-proposal-service.js";
import { ANSWERS_WITH_SEED_PROFILE } from "../edge-proposals/path-relation-proposal-service.js";
import {
  buildObjectFormationOrder,
  buildSessionMap,
  parsePathPairKeys,
  type PathPair,
  type PathPairObject,
  sparsifyPairs
} from "./path-pair-sparsify.js";

// Source of object↔object answer-co-relevance pairs (HQ answer-overlap >= bar,
// canonical `${low}|${high}` keys). The overlap math lives behind this port; the
// producer never touches HQ text. Satisfied by HqAnswerOverlapPairSource.
export interface AnswerCoRelevancePairSourcePort {
  answerCoRelevantPairKeys(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
    readonly bar: number;
  }): Promise<ReadonlySet<string>>;
}

export interface AnswersWithEdgeMintPort {
  submitCandidate(input: SubmitCandidateInput): Promise<PathMintOutcome>;
}

export interface AnswersWithEdgeProducerDeps {
  readonly pairSource: AnswerCoRelevancePairSourcePort;
  readonly mintPort: AnswersWithEdgeMintPort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export interface AnswersWithCrystallizeInput {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly objects: readonly PathPairObject[];
  readonly bar: number;
  readonly capPerNode: number;
  readonly crossSessionOnly: boolean;
}

export interface AnswersWithCrystallizeResult {
  readonly coRelevantPairs: number;
  readonly keptPairs: number;
  readonly minted: number;
}

const EMPTY_RESULT: AnswersWithCrystallizeResult = Object.freeze({
  coRelevantPairs: 0,
  keptPairs: 0,
  minted: 0
});

// Crystallize answers_with edges from HQ answer-overlap — two memories that
// answer the same batch of questions become answer-co-relevant. Mirrors
// CoherenceEdgeProducerService (same sparsify + mint path) but feeds the path
// axis an answer-relation edge instead of a co-occurrence one. Sparsified
// (cross-session + per-node cap) so a dense answer cluster cannot flood the graph.
export class AnswersWithEdgeProducerService {
  public constructor(private readonly deps: AnswersWithEdgeProducerDeps) {}

  public async crystallize(input: AnswersWithCrystallizeInput): Promise<AnswersWithCrystallizeResult> {
    if (input.objects.length < 2) {
      return EMPTY_RESULT;
    }
    const objectIds = input.objects.map((object) => object.objectId);
    const sessionById = buildSessionMap(input.objects);
    const objectOrder = buildObjectFormationOrder(input.objects);
    const pairKeys = await this.loadCoRelevantPairs(input, objectIds);
    if (pairKeys.size === 0) {
      return EMPTY_RESULT;
    }
    const coRelevant = parsePathPairKeys(pairKeys);
    const kept = sparsifyPairs(
      coRelevant,
      sessionById,
      objectOrder,
      input.capPerNode,
      input.crossSessionOnly
    );
    if (kept.length === 0) {
      return Object.freeze({ coRelevantPairs: coRelevant.length, keptPairs: 0, minted: 0 });
    }
    const minted = await this.mintCoRelevantPairs(input, kept);
    return Object.freeze({ coRelevantPairs: coRelevant.length, keptPairs: kept.length, minted });
  }

  private async loadCoRelevantPairs(
    input: AnswersWithCrystallizeInput,
    objectIds: readonly string[]
  ): Promise<ReadonlySet<string>> {
    try {
      return await this.deps.pairSource.answerCoRelevantPairKeys({
        workspaceId: input.workspaceId,
        runId: input.runId,
        objectIds,
        bar: input.bar
      });
    } catch (error) {
      this.deps.warn?.("answer co-relevance lookup failed", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        error: error instanceof Error ? error.message : String(error)
      });
      return new Set<string>();
    }
  }

  private async mintCoRelevantPairs(
    input: AnswersWithCrystallizeInput,
    kept: readonly PathPair[]
  ): Promise<number> {
    let minted = 0;
    for (const [source, target] of kept) {
      const outcome = await this.deps.mintPort.submitCandidate({
        workspaceId: input.workspaceId,
        sourceAnchor: { kind: "object", object_id: source },
        targetAnchor: { kind: "object", object_id: target },
        relationKind: ANSWERS_WITH_SEED_PROFILE.relationKind,
        initialStrength: ANSWERS_WITH_SEED_PROFILE.initialStrength,
        governanceClass: ANSWERS_WITH_SEED_PROFILE.governanceClass,
        evidenceBasis: ANSWERS_WITH_SEED_PROFILE.evidenceBasis,
        recallBiasSign: ANSWERS_WITH_SEED_PROFILE.recallBiasSign,
        recallBiasMagnitude: ANSWERS_WITH_SEED_PROFILE.recallBiasMagnitude,
        runId: input.runId
      });
      if (outcome === "applied") {
        minted += 1;
      }
    }
    return minted;
  }
}
