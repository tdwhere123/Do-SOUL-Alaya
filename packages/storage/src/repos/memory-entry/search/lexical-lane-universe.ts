import { createHash } from "node:crypto";
import { compareCodeUnits, type StorageTier } from "@do-soul/alaya-protocol";
import type { KeywordLaneTokens } from "../keyword-search.js";

export type LexicalRawRankLaneId =
  | "exact"
  | "porter"
  | "trigram"
  | "object_key_porter"
  | "object_key_trigram";

export const LEXICAL_LANE_UNIVERSE_PRODUCER_ID =
  "alaya.storage.lexicalLaneEvaluatedUniverse.v1";

export const LEXICAL_LANE_INDEX_KIND = Object.freeze({
  exact: "memory_entries",
  porter: "memory_content_fts_porter",
  trigram: "memory_content_fts",
  object_key_porter: "memory_object_key_fts",
  object_key_trigram: "memory_object_key_fts_trigram"
} as const);

export type LexicalLaneIndexKind =
  typeof LEXICAL_LANE_INDEX_KIND[LexicalRawRankLaneId];

export type LexicalLaneUniverseApplicability =
  | Readonly<{ readonly applicable: true }>
  | Readonly<{ readonly applicable: false; readonly reason: "no_tokens_routed" }>;

export type LexicalLaneUniverseScope = Readonly<{
  readonly workspace_id: string;
  readonly object_ids: readonly string[] | null;
  readonly tier: StorageTier | null;
}>;

export type LexicalLaneEvaluatedUniverseWitness = Readonly<{
  readonly producer_id: typeof LEXICAL_LANE_UNIVERSE_PRODUCER_ID;
  readonly lane_id: LexicalRawRankLaneId;
  readonly index_kind: LexicalLaneIndexKind;
  readonly tokens_routed: boolean;
  readonly applicability: LexicalLaneUniverseApplicability;
  readonly scope: LexicalLaneUniverseScope;
  readonly candidate_keys: readonly string[];
  readonly count: number;
  readonly universe_digest: `sha256:${string}`;
}>;

export type LexicalLaneUniverseMap = Readonly<
  Record<LexicalRawRankLaneId, LexicalLaneEvaluatedUniverseWitness>
>;

export function contentFtsLaneDropsRequestedTier(
  laneId: LexicalRawRankLaneId,
  objectIds: readonly string[] | undefined
): boolean {
  return (laneId === "porter" || laneId === "trigram") && objectIds !== undefined;
}

export function sealLexicalLaneUniverseScope(input: Readonly<{
  readonly workspaceId: string;
  readonly objectIds?: readonly string[];
  readonly tier?: StorageTier;
  readonly laneId?: LexicalRawRankLaneId;
}>): LexicalLaneUniverseScope {
  const objectIds = input.objectIds === undefined || input.objectIds.length === 0
    ? null
    : Object.freeze([...new Set(input.objectIds)].sort(compareCodeUnits));
  const dropTier = input.laneId !== undefined &&
    contentFtsLaneDropsRequestedTier(input.laneId, input.objectIds);
  return Object.freeze({
    workspace_id: input.workspaceId,
    object_ids: objectIds,
    tier: dropTier ? null : input.tier ?? null
  });
}

export function laneTokensWereRouted(
  tokens: KeywordLaneTokens,
  laneId: LexicalRawRankLaneId
): boolean {
  if (laneId === "exact") return tokens.exact.length > 0;
  if (laneId === "porter" || laneId === "object_key_porter") {
    return tokens.porter.length > 0;
  }
  return tokens.trigram.length > 0;
}

export function sealLexicalLaneEvaluatedUniverse(input: Readonly<{
  readonly laneId: LexicalRawRankLaneId;
  readonly tokensRouted: boolean;
  readonly scope: LexicalLaneUniverseScope;
  readonly candidateKeys: readonly string[];
}>): LexicalLaneEvaluatedUniverseWitness {
  const candidateKeys = input.tokensRouted
    ? Object.freeze([...new Set(input.candidateKeys)].sort(compareCodeUnits))
    : Object.freeze([]);
  const applicability = input.tokensRouted
    ? Object.freeze({ applicable: true as const })
    : Object.freeze({ applicable: false as const, reason: "no_tokens_routed" as const });
  return digestWitness(Object.freeze({
    producer_id: LEXICAL_LANE_UNIVERSE_PRODUCER_ID,
    lane_id: input.laneId,
    index_kind: LEXICAL_LANE_INDEX_KIND[input.laneId],
    tokens_routed: input.tokensRouted,
    applicability,
    scope: input.scope,
    candidate_keys: candidateKeys,
    count: candidateKeys.length
  }));
}

export function lexicalLaneUniverseDigestPreimage(
  witness: Omit<LexicalLaneEvaluatedUniverseWitness, "universe_digest">
): string {
  return JSON.stringify({
    producer_id: witness.producer_id,
    lane_id: witness.lane_id,
    index_kind: witness.index_kind,
    tokens_routed: witness.tokens_routed,
    applicability: witness.applicability,
    scope: {
      workspace_id: witness.scope.workspace_id,
      object_ids: witness.scope.object_ids,
      tier: witness.scope.tier
    },
    candidate_keys: witness.candidate_keys,
    count: witness.count
  });
}

function digestWitness(
  body: Omit<LexicalLaneEvaluatedUniverseWitness, "universe_digest">
): LexicalLaneEvaluatedUniverseWitness {
  return Object.freeze({
    ...body,
    universe_digest: `sha256:${createHash("sha256")
      .update(lexicalLaneUniverseDigestPreimage(body), "utf8")
      .digest("hex")}` as const
  });
}
