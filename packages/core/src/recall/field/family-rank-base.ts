import type {
  RecallFiniteFieldChannelReceipt,
  RecallFiniteFieldSeal
} from "./finite-field-seal.js";
import { verifyRecallFiniteFieldSeal } from "./finite-field-seal.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from "./field-identity.js";
import { compareText } from "../../shared/compare-text.js";

export const FIXED_FAMILY_RANK_BASE_OPERATOR_ID =
  "fixed_family_rank_base_v1";

export type FixedFamilyRankChannelConfig = Readonly<{
  readonly channel_id: string;
  readonly kappa: number;
}>;

export type FixedFamilyRankDefinition = Readonly<{
  readonly family_id: string;
  readonly weight: number;
  readonly channels: readonly Readonly<FixedFamilyRankChannelConfig>[];
}>;

export type FixedFamilyChannelResponse = Readonly<{
  readonly channel_id: string;
  readonly status: RecallFiniteFieldChannelReceipt["status"];
  readonly kappa: number;
  readonly rank: number | null;
  readonly response: number;
  readonly unseen_upper_bound: number | null;
}>;

export type FixedFamilyRankBaseReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof FIXED_FAMILY_RANK_BASE_OPERATOR_ID;
  readonly candidate_key: string;
  readonly seal_digest: `sha256:${string}`;
  readonly configuration_digest: RecallFieldDigest;
  readonly denominator: number;
  readonly score: number;
  readonly best_unseen_score_upper_bound: number | null;
  readonly channel_responses: readonly Readonly<FixedFamilyChannelResponse>[];
  readonly family_ballots: readonly Readonly<{
    readonly family_id: string;
    readonly weight: number;
    readonly channel_ids: readonly string[];
    readonly response: number;
    readonly weighted_response: number;
    readonly unseen_upper_bound: number | null;
  }>[];
}>;

export function computeFixedFamilyRankBase(params: Readonly<{
  readonly candidate_key: string;
  readonly seal: Readonly<RecallFiniteFieldSeal>;
  readonly families: readonly Readonly<FixedFamilyRankDefinition>[];
}>): FixedFamilyRankBaseReceipt {
  assertIdentity(params.candidate_key, "candidate key");
  verifyRecallFiniteFieldSeal(params.seal);
  const config = validateFamilyConfig(params.families, params.seal.channel_catalog);
  const channelsById = new Map(params.seal.channels.map((channel) => [
    channel.channel_id,
    channel
  ]));
  const channelResponses = new Map<string, FixedFamilyChannelResponse>();
  const familyBallots = config.families.map((family) => {
    const responses = family.channels.map(({ channel_id, kappa }) => {
      const response = channelResponse(
        channelsById.get(channel_id)!,
        params.candidate_key,
        kappa
      );
      channelResponses.set(channel_id, response);
      return response;
    });
    const response = Math.max(0, ...responses.map((value) => value.response));
    const unseenValues = responses.map((value) => value.unseen_upper_bound);
    const finiteUnseenValues = unseenValues.filter(
      (value): value is number => value !== null
    );
    const unseen = finiteUnseenValues.length !== unseenValues.length
      ? null
      : Math.max(0, ...finiteUnseenValues);
    return Object.freeze({
      family_id: family.family_id,
      weight: family.weight,
      channel_ids: Object.freeze(family.channels.map(({ channel_id }) => channel_id)),
      response,
      weighted_response: family.weight * response,
      unseen_upper_bound: unseen
    });
  });
  const numerator = familyBallots.reduce((sum, ballot) =>
    sum + ballot.weighted_response, 0);
  const unseenNumerator = familyBallots.some(({ unseen_upper_bound }) =>
    unseen_upper_bound === null
  ) ? null : familyBallots.reduce((sum, ballot) =>
    sum + ballot.weight * ballot.unseen_upper_bound!, 0);
  return Object.freeze({
    schema_version: 1,
    operator_id: FIXED_FAMILY_RANK_BASE_OPERATOR_ID,
    candidate_key: params.candidate_key,
    seal_digest: params.seal.seal_digest,
    configuration_digest: config.configurationDigest,
    denominator: config.denominator,
    score: numerator / config.denominator,
    best_unseen_score_upper_bound: unseenNumerator === null
      ? null
      : unseenNumerator / config.denominator,
    channel_responses: Object.freeze(params.seal.channel_catalog.map((channelId) =>
      channelResponses.get(channelId)!
    )),
    family_ballots: Object.freeze(familyBallots)
  });
}

function channelResponse(
  channel: Readonly<RecallFiniteFieldChannelReceipt>,
  candidateKey: string,
  kappa: number
): FixedFamilyChannelResponse {
  const rank = channel.observations.reduce<number | null>((best, observation) => {
    if (observation.candidate_key !== candidateKey) return best;
    return best === null ? observation.rank : Math.min(best, observation.rank);
  }, null);
  return Object.freeze({
    channel_id: channel.channel_id,
    status: channel.status,
    kappa,
    rank,
    response: rank === null ? 0 : kappa / (kappa + rank),
    unseen_upper_bound: channel.unseen_upper_bound
  });
}

function validateFamilyConfig(
  families: readonly Readonly<FixedFamilyRankDefinition>[],
  channelCatalog: readonly string[]
): Readonly<{
  readonly denominator: number;
  readonly configurationDigest: RecallFieldDigest;
  readonly families: readonly Readonly<FixedFamilyRankDefinition>[];
}> {
  const familyIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const family of families) {
    assertIdentity(family.family_id, "family id");
    if (familyIds.has(family.family_id)) throw new Error("family ids must be unique");
    if (!Number.isFinite(family.weight) || family.weight < 0) {
      throw new Error("family weight must be finite and non-negative");
    }
    if (family.channels.length === 0) throw new Error("family must own at least one channel");
    familyIds.add(family.family_id);
    validateFamilyChannels(family.channels, channelIds, channelCatalog);
  }
  if (channelIds.size !== channelCatalog.length) {
    throw new Error("family configuration must own every field channel exactly once");
  }
  const channelOrder = new Map(channelCatalog.map((channelId, index) => [channelId, index]));
  const normalizedFamilies = Object.freeze(families.map((family) => Object.freeze({
    ...family,
    channels: Object.freeze(family.channels.map((channel) => Object.freeze({ ...channel }))
      .sort((left, right) =>
        channelOrder.get(left.channel_id)! - channelOrder.get(right.channel_id)!
      ))
  })).sort((left, right) => compareText(left.family_id, right.family_id)));
  const denominator = normalizedFamilies.reduce((sum, family) => sum + family.weight, 0);
  if (denominator <= 0) throw new Error("fixed family denominator must be positive");
  return Object.freeze({
    denominator,
    configurationDigest: digestRecallFieldIdentity({ families: normalizedFamilies }),
    families: normalizedFamilies
  });
}

function validateFamilyChannels(
  channels: readonly Readonly<FixedFamilyRankChannelConfig>[],
  seen: Set<string>,
  channelCatalog: readonly string[]
): void {
  for (const channel of channels) {
    assertIdentity(channel.channel_id, "family channel id");
    if (!channelCatalog.includes(channel.channel_id) || seen.has(channel.channel_id)) {
      throw new Error("family channels must partition the field channel catalog");
    }
    if (!Number.isFinite(channel.kappa) || channel.kappa <= 0) {
      throw new Error("reciprocal-rank kappa must be finite and positive");
    }
    seen.add(channel.channel_id);
  }
}

function assertIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

