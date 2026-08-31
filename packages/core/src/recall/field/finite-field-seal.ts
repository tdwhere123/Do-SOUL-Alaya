import { stableStringify } from "../../shared/stable-stringify.js";
import { compareText } from "../../shared/compare-text.js";
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

export type RecallFiniteFieldClosureSensitivity = Readonly<{
  readonly sensitivity_id: string;
  readonly effect: "proposition_bound" | "extremum_interval";
  readonly target: string;
}>;

export type RecallFiniteFieldClosureAuthorityState = Readonly<{
  readonly source_seal: RecallFiniteFieldSeal;
  readonly source_channel: RecallFiniteFieldChannelReceipt;
  readonly query_digest: RecallFieldDigest;
  readonly request_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly workspace_id: string;
  readonly observer_id: string;
  readonly channel_id: string;
  readonly domain_id: string;
  readonly universe_digest: RecallFieldDigest;
  readonly candidate_key_domain: string;
  readonly eligible_candidate_keys: readonly string[];
  readonly sensitivities: readonly RecallFiniteFieldClosureSensitivity[];
  readonly extremum_intervals: readonly Readonly<{
    readonly binding_id: string;
    readonly lower: number;
    readonly upper: number;
  }>[];
  readonly remaining_numeric_effect: Readonly<{
    readonly effect_id: string;
    readonly sensitivity_id: string;
    readonly effect: "proposition_bound" | "extremum_interval";
    readonly lower: number;
    readonly upper: number;
  }> | null;
}>;

declare const finiteFieldClosureAuthorityBrand: unique symbol;
export type RecallFiniteFieldClosureAuthority = Readonly<{
  readonly [finiteFieldClosureAuthorityBrand]: true;
}>;

const issuedFiniteFieldSeals = new WeakSet<object>();
const finiteClosureAuthorityStates = new WeakMap<
  object,
  RecallFiniteFieldClosureAuthorityState
>();
const finiteClosureAuthoritiesBySeal = new WeakMap<
  object,
  Map<string, RecallFiniteFieldClosureAuthority>
>();

export function createRecallFiniteFieldSeal(params: Readonly<{
  readonly upstream_snapshot_digest: RecallFieldDigest;
  readonly channel_catalog: readonly string[];
  readonly channels: readonly Readonly<RecallFiniteFieldChannelInput>[];
}>): RecallFiniteFieldSeal {
  assertAllowedKeys(params, ["upstream_snapshot_digest", "channel_catalog", "channels"],
    ["upstream_snapshot_digest", "channel_catalog", "channels"],
    "finite field seal input");
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
  const seal = Object.freeze({
    ...body,
    seal_digest: digestRecallFieldIdentity(body)
  });
  issuedFiniteFieldSeals.add(seal);
  return seal;
}

export function issueRecallFiniteFieldClosureAuthority(params: Readonly<{
  readonly seal: RecallFiniteFieldSeal;
  readonly channel_id: string;
  readonly query_digest: RecallFieldDigest;
  readonly request_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly workspace_id: string;
  readonly observer_id: string;
  readonly domain_id: string;
  readonly candidate_key_domain: string;
  readonly eligible_candidate_keys?: readonly string[];
  readonly sensitivity?: RecallFiniteFieldClosureSensitivity;
  readonly extremum_intervals?: readonly Readonly<{
    readonly binding_id: string;
    readonly lower: number;
    readonly upper: number;
  }>[];
}>): RecallFiniteFieldClosureAuthority {
  assertAllowedKeys(params, [
    "seal", "channel_id", "query_digest", "request_digest", "principal_digest",
    "workspace_id", "observer_id", "domain_id", "candidate_key_domain",
    "eligible_candidate_keys", "sensitivity", "extremum_intervals"
  ], [
    "seal", "channel_id", "query_digest", "request_digest", "principal_digest",
    "workspace_id", "observer_id", "domain_id", "candidate_key_domain"
  ], "finite field closure authority input");
  verifyRecallFiniteFieldSeal(params.seal);
  if (!issuedFiniteFieldSeals.has(params.seal)) {
    throw new Error("finite field closure requires a source-issued seal");
  }
  const channel = params.seal.channels.find(({ channel_id }) =>
    channel_id === params.channel_id);
  if (channel === undefined) throw new Error("finite field closure channel is absent");
  const state = materializeFiniteClosureAuthorityState(params, channel);
  let byChannel = finiteClosureAuthoritiesBySeal.get(params.seal);
  if (byChannel === undefined) {
    byChannel = new Map();
    finiteClosureAuthoritiesBySeal.set(params.seal, byChannel);
  }
  const existing = byChannel.get(params.channel_id);
  if (existing !== undefined) {
    const prior = readRecallFiniteFieldClosureAuthority(existing);
    if (stableStringify(prior) !== stableStringify(state)) {
      throw new Error("finite field source receipt is already bound to another closure scope");
    }
    return existing;
  }
  const authority = Object.freeze({}) as RecallFiniteFieldClosureAuthority;
  finiteClosureAuthorityStates.set(authority, state);
  byChannel.set(params.channel_id, authority);
  return authority;
}

export function readRecallFiniteFieldClosureAuthority(
  authority: RecallFiniteFieldClosureAuthority
): RecallFiniteFieldClosureAuthorityState {
  const state = finiteClosureAuthorityStates.get(authority);
  if (state === undefined) throw new Error("finite field closure authority is invalid");
  verifyRecallFiniteFieldSeal(state.source_seal);
  return state;
}

function materializeFiniteClosureAuthorityState(
  params: Parameters<typeof issueRecallFiniteFieldClosureAuthority>[0],
  channel: RecallFiniteFieldChannelReceipt
): RecallFiniteFieldClosureAuthorityState {
  [params.query_digest, params.request_digest, params.principal_digest]
    .forEach((value) => assertSha256(value, "finite closure identity digest"));
  [params.workspace_id, params.observer_id, params.domain_id,
    params.candidate_key_domain].forEach((value) =>
    assertIdentity(value, "finite closure identity"));
  const eligible = freezeUniqueIdentities(
    params.eligible_candidate_keys ?? channel.observations.map(({ candidate_key }) =>
      candidate_key),
    "finite closure eligible candidate"
  ).slice().sort(compareText);
  if (channel.status === "complete" && channel.observations.some(({ candidate_key }) =>
    !eligible.includes(candidate_key))) {
    throw new Error("finite closure eligible universe omits an observed candidate");
  }
  const sensitivity = params.sensitivity === undefined
    ? []
    : [freezeFiniteClosureSensitivity(params.sensitivity)];
  const intervals = freezeExtremumIntervals(
    params.extremum_intervals ?? [],
    eligible,
    sensitivity[0]
  );
  const universeDigest = digestRecallFieldIdentity({
    operator_id: "finite_field_source_universe_v1",
    source_channel_digest: channel.channel_digest,
    candidate_key_domain: params.candidate_key_domain,
    eligible_candidate_keys: eligible
  });
  const remaining = channel.status === "truncated" && sensitivity[0] !== undefined &&
      channel.unseen_upper_bound !== null
    ? Object.freeze({
        effect_id: `${sensitivity[0].sensitivity_id}:source-unseen`,
        sensitivity_id: sensitivity[0].sensitivity_id,
        effect: sensitivity[0].effect,
        lower: 0,
        upper: channel.unseen_upper_bound
      })
    : null;
  return Object.freeze({
    source_seal: params.seal,
    source_channel: channel,
    query_digest: params.query_digest,
    request_digest: params.request_digest,
    snapshot_digest: params.seal.upstream_snapshot_digest,
    principal_digest: params.principal_digest,
    workspace_id: params.workspace_id,
    observer_id: params.observer_id,
    channel_id: channel.channel_id,
    domain_id: params.domain_id,
    universe_digest: universeDigest,
    candidate_key_domain: params.candidate_key_domain,
    eligible_candidate_keys: Object.freeze(eligible),
    sensitivities: Object.freeze(sensitivity),
    extremum_intervals: intervals,
    remaining_numeric_effect: remaining
  });
}

function freezeExtremumIntervals(
  values: readonly Readonly<{
    readonly binding_id: string;
    readonly lower: number;
    readonly upper: number;
  }>[],
  eligible: readonly string[],
  sensitivity: RecallFiniteFieldClosureSensitivity | undefined
) {
  if (values.length === 0) return Object.freeze([]);
  if (sensitivity?.effect !== "extremum_interval") {
    throw new Error("finite extremum intervals require an extremum sensitivity");
  }
  const intervals = values.map((value) => {
    assertAllowedKeys(value, ["binding_id", "lower", "upper"],
      ["binding_id", "lower", "upper"], "finite extremum interval");
    assertIdentity(value.binding_id, "finite extremum binding");
    if (![value.lower, value.upper].every(Number.isFinite) || value.upper < value.lower) {
      throw new Error("finite extremum interval is invalid");
    }
    return Object.freeze({ ...value });
  }).sort((left, right) => compareText(left.binding_id, right.binding_id));
  if (new Set(intervals.map(({ binding_id }) => binding_id)).size !== intervals.length ||
      intervals.length !== eligible.length ||
      intervals.some(({ binding_id }, index) => binding_id !== eligible[index])) {
    throw new Error("finite extremum intervals must exactly cover the eligible universe");
  }
  return Object.freeze(intervals);
}

function freezeFiniteClosureSensitivity(
  sensitivity: RecallFiniteFieldClosureSensitivity
): RecallFiniteFieldClosureSensitivity {
  assertAllowedKeys(sensitivity, ["sensitivity_id", "effect", "target"],
    ["sensitivity_id", "effect", "target"], "finite closure sensitivity");
  assertIdentity(sensitivity.sensitivity_id, "finite closure sensitivity");
  assertIdentity(sensitivity.target, "finite closure sensitivity target");
  if (sensitivity.effect !== "proposition_bound" &&
      sensitivity.effect !== "extremum_interval") {
    throw new Error("finite closure sensitivity effect is unsupported");
  }
  return Object.freeze({ ...sensitivity });
}

export function verifyRecallFiniteFieldSeal(seal: RecallFiniteFieldSeal): void {
  assertAllowedKeys(seal, [
    "schema_version", "operator_id", "upstream_snapshot_digest", "channel_catalog",
    "channels", "seal_digest"
  ], [
    "schema_version", "operator_id", "upstream_snapshot_digest", "channel_catalog",
    "channels", "seal_digest"
  ], "finite field seal");
  seal.channels.forEach((channel) => assertAllowedKeys(channel, [
    "channel_id", "status", "depth", "observations", "unseen_upper_bound",
    "channel_digest"
  ], [
    "channel_id", "status", "depth", "observations", "unseen_upper_bound",
    "channel_digest"
  ], "finite field channel receipt"));
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
  assertAllowedKeys(input, [
    "channel_id", "status", "depth", "observations", "unseen_upper_bound"
  ], ["channel_id", "status", "depth", "observations", "unseen_upper_bound"],
  "finite field channel");
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
    assertAllowedKeys(observation, ["observation_id", "candidate_key", "rank"],
      ["observation_id", "candidate_key", "rank"], "finite field observation");
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

function assertAllowedKeys(
  value: object,
  allowed: readonly string[],
  required: readonly string[],
  field: string
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) =>
    !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${field} has unknown or missing fields`);
  }
}

const CHANNEL_STATUSES: ReadonlySet<string> = new Set([
  "complete",
  "truncated",
  "unavailable",
  "ineligible"
]);
