import { createHash } from "node:crypto";
import { stableStringify } from "../../shared/stable-stringify.js";
import type {
  RelationAssertionAdmissionPort,
  RelationAssertionAdmissionRequest
} from "../relation-assertions/relation-assertion-service-types.js";
import {
  buildObjectFormationOrder,
  buildSessionMap,
  type PathPair,
  type PathPairObject,
  sparsifyPairs
} from "./path-pair-sparsify.js";

export interface AnswerCoRelevancePairWitness {
  readonly pair: PathPair;
  readonly evidenceReceipts: RelationAssertionAdmissionRequest["evidenceReceipts"];
  readonly formationReceipt: RelationAssertionAdmissionRequest["formationReceipt"];
  readonly validFrom: string;
}

export interface AnswerCoRelevancePairSourcePort {
  answerCoRelevantPairs(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
    readonly bar: number;
  }): Promise<readonly AnswerCoRelevancePairWitness[]>;
}

export type AnswersWithRelationAssertionPort = RelationAssertionAdmissionPort;

export interface AnswersWithEdgeProducerDeps {
  readonly pairSource: AnswerCoRelevancePairSourcePort;
  readonly assertionPort: AnswersWithRelationAssertionPort;
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
  readonly admitted: number;
}

const EMPTY_RESULT: AnswersWithCrystallizeResult = Object.freeze({
  coRelevantPairs: 0,
  keptPairs: 0,
  admitted: 0
});

// Sparsification bounds dense answer clusters before immutable assertion admission.
export class AnswersWithEdgeProducerService {
  public constructor(private readonly deps: AnswersWithEdgeProducerDeps) {}

  public async crystallize(input: AnswersWithCrystallizeInput): Promise<AnswersWithCrystallizeResult> {
    return await (await this.prepare(input)).execute();
  }

  /** Freeze the exact witnessed pair plan before any assertion admission. */
  public async prepare(input: AnswersWithCrystallizeInput): Promise<Readonly<{
    readonly digest: string;
    execute(assertCurrentInTransaction?: () => undefined): Promise<AnswersWithCrystallizeResult>;
  }>> {
    const objectIds = input.objects.map((object) => object.objectId);
    const sessionById = buildSessionMap(input.objects);
    const objectOrder = buildObjectFormationOrder(input.objects);
    const witnesses = input.objects.length < 2 ? [] : await this.loadCoRelevantPairs(input, objectIds);
    const witnessByPair = new Map(witnesses.map((witness) => [pairKey(witness.pair), witness]));
    const kept = sparsifyPairs(witnesses.map((witness) => witness.pair), sessionById, objectOrder,
      input.capPerNode, input.crossSessionOnly);
    const digest = createHash("sha256").update(stableStringify({
      input: { ...input, objects: [...input.objects].sort((a, b) => compareIds(a.objectId, b.objectId)) },
      witnesses: [...witnesses].sort((a, b) => compareIds(pairKey(a.pair), pairKey(b.pair))), kept
    }), "utf8").digest("hex");
    return Object.freeze({
      digest,
      execute: async (assertCurrentInTransaction?: () => undefined) => {
        if (witnesses.length === 0) return EMPTY_RESULT;
        const admitted = await this.admitCoRelevantPairs(input, kept, witnessByPair, assertCurrentInTransaction);
        return Object.freeze({ coRelevantPairs: witnesses.length, keptPairs: kept.length, admitted });
      }
    });
  }

  private async loadCoRelevantPairs(
    input: AnswersWithCrystallizeInput,
    objectIds: readonly string[]
  ): Promise<readonly AnswerCoRelevancePairWitness[]> {
    try {
      return await this.deps.pairSource.answerCoRelevantPairs({
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
      throw error;
    }
  }

  private async admitCoRelevantPairs(
    input: AnswersWithCrystallizeInput,
    kept: readonly PathPair[],
    witnessByPair: ReadonlyMap<string, AnswerCoRelevancePairWitness>,
    assertCurrentInTransaction?: () => undefined
  ): Promise<number> {
    let admitted = 0;
    for (const [source, target] of kept) {
      const witness = witnessByPair.get(pairKey([source, target]));
      if (witness === undefined) {
        throw new Error(`Missing formation witness for answers_with pair ${source}|${target}.`);
      }
      const outcome = await this.deps.assertionPort.admit({
        workspaceId: input.workspaceId,
        runId: input.runId,
        causedBy: "answers_with_edge_producer",
        evidenceReceipts: witness.evidenceReceipts,
        formationReceipt: witness.formationReceipt,
        anchors: {
          source_anchor: { kind: "object", object_id: source },
          target_anchor: { kind: "object", object_id: target }
        },
        relationKind: "answers_with",
        validity: { kind: "open", valid_from: witness.validFrom },
        ...(assertCurrentInTransaction === undefined ? {} : { assertCurrentInTransaction })
      });
      if (outcome.status === "admitted") admitted += 1;
    }
    return admitted;
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pairKey(pair: PathPair): string {
  const [left, right] = pair;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}
