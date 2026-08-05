import { stableStringify } from "../../shared/stable-stringify.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from "./field-identity.js";

export const RECALL_FINITE_FIELD_SEAL_OPERATOR_ID =
  "recall_finite_field_seal_v1";

export type RecallFiniteFieldChannelStatus =
  | "complete"
  | "truncated"
  | "unavailable"
  | "ineligible";

export type RecallFiniteFieldObservation = Readonly<{
  readonly observation_id: string;
  readonly candidate_key: string;
  readonly rank: number;
}>;

export type RecallFiniteFieldChannelInput = Readonly<{
  readonly channel_id: string;
  readonly status: RecallFiniteFieldChannelStatus;
  readonly depth: number;
  readonly observations: readonly Readonly<RecallFiniteFieldObservation>[];
  readonly unseen_upper_bound: number | null;
}>;

export type RecallFiniteFieldChannelReceipt = RecallFiniteFieldChannelInput & Readonly<{
  readonly channel_digest: RecallFieldDigest;
}>;

export type RecallFiniteFieldSeal = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof RECALL_FINITE_FIELD_SEAL_OPERATOR_ID;
  readonly upstream_snapshot_digest: RecallFieldDigest;
  readonly channel_catalog: readonly string[];
  readonly channels: readonly Readonly<RecallFiniteFieldChannelReceipt>[];
  readonly seal_digest: RecallFieldDigest;
}>;

export function createRecallFiniteFieldSeal(params: Readonly<{
  readonly upstream_snapshot_digest: RecallFieldDigest;
  readonly channel_catalog: readonly string[];
  readonly channels: readonly Readonly<RecallFiniteFieldChannelInput>[];
}>): RecallFiniteFieldSeal {
  assertSha256(params.upstream_snapshot_digest, "upstream snapshot digest");
  const catalog = freezeUniqueIdentities(params.channel_catalog, "channel catalog");
  const inputs = indexChannels(params.channels, catalog);
  const channels = Object.freeze(catalog.map((channelId) =>
    materializeChannel(inputs.get(channelId)!, params.upstream_snapshot_digest)
  ));
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: RECALL_FINITE_FIELD_SEAL_OPERATOR_ID,
    upstream_snapshot_digest: params.upstream_snapshot_digest,
    channel_catalog: catalog,
    channels
  });
  return Object.freeze({ ...body, seal_digest: digestRecallFieldIdentity(body) });
}

export function verifyRecallFiniteFieldSeal(seal: RecallFiniteFieldSeal): void {
  if (seal.schema_version !== 1 ||
      seal.operator_id !== RECALL_FINITE_FIELD_SEAL_OPERATOR_ID) {
    throw new Error("finite field schema or operator mismatch");
  }
  const rebuilt = createRecallFiniteFieldSeal({
    upstream_snapshot_digest: seal.upstream_snapshot_digest,
    channel_catalog: seal.channel_catalog,
    channels: seal.channels.map(({ channel_digest: _digest, ...channel }) => channel)
  });
  if (rebuilt.seal_digest !== seal.seal_digest ||
      rebuilt.channels.some((channel, index) =>
        channel.channel_digest !== seal.channels[index]?.channel_digest)) {
    throw new Error("finite field digest mismatch");
  }
}

export function assertRecallFiniteFieldRefinement(
  previous: RecallFiniteFieldSeal,
  next: RecallFiniteFieldSeal
): void {
  verifyRecallFiniteFieldSeal(previous);
  verifyRecallFiniteFieldSeal(next);
  if (previous.upstream_snapshot_digest !== next.upstream_snapshot_digest ||
      stableStringify(previous.channel_catalog) !== stableStringify(next.channel_catalog)) {
    throw new Error("finite field refinement requires one catalog and upstream snapshot");
  }
  previous.channels.forEach((channel, index) =>
    assertChannelRefinement(channel, next.channels[index]!)
  );
}

function materializeChannel(
  input: Readonly<RecallFiniteFieldChannelInput>,
  upstreamSnapshotDigest: string
): RecallFiniteFieldChannelReceipt {
  assertChannel(input);
  const observations = Object.freeze(input.observations.map((observation) =>
    Object.freeze({ ...observation })
  ));
  const body = Object.freeze({ ...input, observations });
  return Object.freeze({
    ...body,
    channel_digest: digestRecallFieldIdentity({
      upstream_snapshot_digest: upstreamSnapshotDigest,
      ...body
    })
  });
}

function assertChannel(input: Readonly<RecallFiniteFieldChannelInput>): void {
  assertIdentity(input.channel_id, "channel id");
  if (!CHANNEL_STATUSES.has(input.status)) {
    throw new Error("finite field channel status is invalid");
  }
  if (!Number.isSafeInteger(input.depth) || input.depth < 0) {
    throw new Error("finite field channel depth must be a non-negative safe integer");
  }
  if ((input.status === "complete" || input.status === "truncated") &&
      !isUnit(input.unseen_upper_bound)) {
    throw new Error(`${input.status} finite field channel requires an unseen bound`);
  }
  if ((input.status === "unavailable" || input.status === "ineligible") &&
      input.unseen_upper_bound !== null) {
    throw new Error(`${input.status} finite field channel cannot claim an unseen bound`);
  }
  if (input.status === "complete" && input.unseen_upper_bound !== 0) {
    throw new Error("complete finite field channel requires a zero unseen upper bound");
  }
  if ((input.status === "unavailable" || input.status === "ineligible") &&
      (input.depth !== 0 || input.observations.length !== 0)) {
    throw new Error(`${input.status} finite field channel cannot contain observations`);
  }
  assertObservations(input.observations, input.depth);
}

function assertObservations(
  observations: readonly Readonly<RecallFiniteFieldObservation>[],
  depth: number
): void {
  const identities = new Set<string>();
  let previousRank = 0;
  for (const observation of observations) {
    assertIdentity(observation.observation_id, "observation id");
    assertIdentity(observation.candidate_key, "candidate key");
    if (identities.has(observation.observation_id)) {
      throw new Error("finite field observation identities must be unique");
    }
    if (!Number.isSafeInteger(observation.rank) || observation.rank < previousRank ||
        observation.rank < 1 || observation.rank > depth) {
      throw new Error("finite field observation ranks must be ordered within depth");
    }
    identities.add(observation.observation_id);
    previousRank = observation.rank;
  }
}

function assertChannelRefinement(
  previous: Readonly<RecallFiniteFieldChannelReceipt>,
  next: Readonly<RecallFiniteFieldChannelReceipt>
): void {
  if (previous.channel_id !== next.channel_id) {
    throw new Error("finite field refinement channel order changed");
  }
  if (previous.status !== "truncated") {
    if (previous.channel_digest !== next.channel_digest) {
      throw new Error("sealed finite field channel cannot change within one snapshot");
    }
    return;
  }
  if (next.status !== "truncated" && next.status !== "complete") {
    throw new Error("truncated finite field channel may only remain truncated or complete");
  }
  if (next.depth < previous.depth ||
      (next.unseen_upper_bound !== null && previous.unseen_upper_bound !== null &&
        next.unseen_upper_bound > previous.unseen_upper_bound)) {
    throw new Error("finite field refinement widened depth or unseen bound");
  }
  const prefix = next.observations.slice(0, previous.observations.length);
  if (stableStringify(prefix) !== stableStringify(previous.observations) ||
      (next.depth === previous.depth &&
        next.observations.length !== previous.observations.length)) {
    throw new Error("finite field refinement must preserve the observation prefix");
  }
}

function indexChannels(
  channels: readonly Readonly<RecallFiniteFieldChannelInput>[],
  catalog: readonly string[]
): ReadonlyMap<string, Readonly<RecallFiniteFieldChannelInput>> {
  const byId = new Map<string, Readonly<RecallFiniteFieldChannelInput>>();
  for (const channel of channels) {
    if (byId.has(channel.channel_id)) throw new Error("finite field channel ids must be unique");
    byId.set(channel.channel_id, channel);
  }
  if (byId.size !== catalog.length || catalog.some((channelId) => !byId.has(channelId))) {
    throw new Error("finite field channels must exactly cover the channel catalog");
  }
  return byId;
}

function freezeUniqueIdentities(values: readonly string[], field: string): readonly string[] {
  const output = values.map((value) => {
    assertIdentity(value, field);
    return value;
  });
  if (new Set(output).size !== output.length) throw new Error(`${field} must be unique`);
  return Object.freeze(output);
}

function assertIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function isUnit(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertSha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

const CHANNEL_STATUSES: ReadonlySet<string> = new Set([
  "complete",
  "truncated",
  "unavailable",
  "ineligible"
]);
