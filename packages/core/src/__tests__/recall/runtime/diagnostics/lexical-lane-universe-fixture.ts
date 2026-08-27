import { createHash } from "node:crypto";
import { compareCodeUnits } from "@do-soul/alaya-protocol";
import {
  LEXICAL_LANE_INDEX_KIND,
  LEXICAL_LANE_UNIVERSE_PRODUCER_ID,
  type LexicalBoundLaneCapture,
  type LexicalBoundLaneId,
  type LexicalBoundProducerReceipt,
  type LexicalLaneEvaluatedUniverseWitness,
  type LexicalLaneUniverseScope
} from "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";

export function universeWitness(input: Readonly<{
  readonly laneId: LexicalBoundLaneId;
  readonly candidateKeys?: readonly string[];
  readonly tokensRouted?: boolean;
  readonly workspaceId?: string;
  readonly objectIds?: readonly string[] | null;
  readonly tier?: "hot" | "warm" | "cold" | null;
}>): LexicalLaneEvaluatedUniverseWitness {
  const tokensRouted = input.tokensRouted ?? true;
  const candidateKeys = Object.freeze(tokensRouted
    ? [...new Set(input.candidateKeys ?? [])].sort(compareCodeUnits)
    : []);
  const body = Object.freeze({
    producer_id: LEXICAL_LANE_UNIVERSE_PRODUCER_ID,
    lane_id: input.laneId,
    index_kind: LEXICAL_LANE_INDEX_KIND[input.laneId],
    tokens_routed: tokensRouted,
    applicability: tokensRouted
      ? Object.freeze({ applicable: true as const })
      : Object.freeze({ applicable: false as const, reason: "no_tokens_routed" as const }),
    scope: Object.freeze({
      workspace_id: input.workspaceId ?? "workspace-1",
      object_ids: input.objectIds === undefined ? null : input.objectIds,
      tier: input.tier === undefined ? null : input.tier
    }) satisfies LexicalLaneUniverseScope,
    candidate_keys: candidateKeys,
    count: candidateKeys.length
  });
  return Object.freeze({
    ...body,
    universe_digest: `sha256:${createHash("sha256")
      .update(JSON.stringify({
        producer_id: body.producer_id,
        lane_id: body.lane_id,
        index_kind: body.index_kind,
        tokens_routed: body.tokens_routed,
        applicability: body.applicability,
        scope: {
          workspace_id: body.scope.workspace_id,
          object_ids: body.scope.object_ids,
          tier: body.scope.tier
        },
        candidate_keys: body.candidate_keys,
        count: body.count
      }), "utf8")
      .digest("hex")}` as const
  });
}

export function receiptWithUniverses(
  receipt: LexicalBoundProducerReceipt,
  assign: (lane: LexicalBoundLaneCapture) => LexicalLaneEvaluatedUniverseWitness | undefined
): LexicalBoundProducerReceipt {
  return Object.freeze({
    ...receipt,
    lanes: Object.freeze(receipt.lanes.map((lane) => {
      const universe = assign(lane);
      return universe === undefined ? lane : Object.freeze({ ...lane, evaluated_universe: universe });
    }))
  });
}

export function matchingUniverses(
  receipt: LexicalBoundProducerReceipt,
  keys: Readonly<Partial<Record<LexicalBoundLaneId, readonly string[]>>> = {}
): LexicalBoundProducerReceipt {
  return receiptWithUniverses(receipt, (lane) => universeWitness({
    laneId: lane.lane_id,
    candidateKeys: [
      ...lane.rows.map((row) => row.candidate_key),
      ...(keys[lane.lane_id] ?? [])
    ]
  }));
}
