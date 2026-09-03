import { createHash } from "node:crypto";
import { OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH } from "./extraction-request.js";

export const TRANSPORT_PACK_CONTRACT_VERSION = 1;

export interface PackableAssertion {
  readonly semanticKey: string;
  readonly assertionId: number;
  readonly text: string;
}

export type TransportPackPolicy =
  | { readonly kind: "reference_batch_8" }
  | { readonly kind: "reference_batch"; readonly assertionsPerPack: 8 | 16 | 24 | 32 }
  | {
      readonly kind: "token_aware";
      readonly maxAssertions: number;
      readonly maxInputTokens: number;
      readonly expectedOutputCap: number;
      readonly systemPromptChars: number;
    };

export interface TransportPack {
  readonly pack_id: string;
  readonly policy_kind: TransportPackPolicy["kind"];
  readonly assertion_ids: readonly number[];
  readonly semantic_keys: readonly string[];
}

export interface TransportPackPlan {
  readonly inventory_digest: string;
  readonly packs: readonly TransportPack[];
  readonly unpackable: readonly Readonly<{
    semanticKey: string;
    assertionId: number;
    reason: "hard_cap_exceeded";
  }>[];
}

export type DemultiplexRejection = Readonly<{
  readonly reason: string;
  readonly semanticKey?: string;
  readonly assertionId?: number;
}>;

export function planTurnTransportPacks(
  assertions: readonly PackableAssertion[],
  policy: TransportPackPolicy
): TransportPackPlan {
  assertTransportPackPolicy(policy);
  const ordered = [...assertions].sort((left, right) => left.assertionId - right.assertionId);
  const packs: TransportPack[] = [];
  const unpackable: { semanticKey: string; assertionId: number; reason: "hard_cap_exceeded" }[] = [];
  if (ordered.length === 0) {
    return freezePlan([emptyPack(policy.kind)], unpackable);
  }
  let offset = 0;
  while (offset < ordered.length) {
    const packed = nextPackSlice(ordered, offset, policy);
    if (packed === 0) {
      const member = ordered[offset]!;
      unpackable.push({ semanticKey: member.semanticKey, assertionId: member.assertionId, reason: "hard_cap_exceeded" });
      offset += 1;
      continue;
    }
    packs.push(makePack(ordered.slice(offset, offset + packed), policy.kind));
    offset += packed;
  }
  return freezePlan(packs, unpackable);
}

export function demultiplexTransportPack(
  pack: TransportPack,
  entries: readonly { readonly semanticKey?: string; readonly assertionId?: number }[]
): Readonly<{
  readonly admittedKeys: readonly string[];
  readonly rejections: readonly DemultiplexRejection[];
}> {
  const allowedKeys = new Set(pack.semantic_keys);
  const allowedIds = new Set(pack.assertion_ids);
  const admittedKeys = new Set<string>();
  const rejections: DemultiplexRejection[] = [];
  const seen = new Set<string>();
  const rejectedMembers = new Set<string>();
  for (const entry of entries) {
    const key = entry.semanticKey;
    const assertionId = entry.assertionId;
    if (key === undefined && assertionId === undefined) {
      rejections.push({ reason: "missing identity" });
      continue;
    }
    if (key !== undefined && !allowedKeys.has(key)) {
      rejections.push({ reason: "foreign or out-of-pack", semanticKey: key });
      continue;
    }
    if (assertionId !== undefined && !allowedIds.has(assertionId)) {
      rejections.push({ reason: "foreign or out-of-pack", assertionId });
      continue;
    }
    if (key !== undefined && assertionId !== undefined) {
      const paired = pack.semantic_keys[pack.assertion_ids.indexOf(assertionId)];
      if (paired !== key) {
        rejections.push({ reason: "mismatched identity", semanticKey: key, assertionId });
        continue;
      }
    }
    const resolved = key ?? pack.semantic_keys[pack.assertion_ids.indexOf(assertionId!)];
    if (resolved === undefined || pack.assertion_ids.filter((id) => id === assertionId).length > 1) {
      rejections.push({ reason: "ambiguous", assertionId, semanticKey: key });
      continue;
    }
    if (seen.has(resolved)) {
      admittedKeys.delete(resolved);
      rejectedMembers.add(resolved);
      rejections.push({ reason: "duplicate", semanticKey: resolved });
      continue;
    }
    seen.add(resolved);
    if (!rejectedMembers.has(resolved)) admittedKeys.add(resolved);
  }
  return Object.freeze({
    admittedKeys: Object.freeze([...admittedKeys]),
    rejections: Object.freeze(rejections)
  });
}

function nextPackSlice(
  ordered: readonly PackableAssertion[],
  offset: number,
  policy: TransportPackPolicy
): number {
  if (policy.kind === "reference_batch_8") {
    return Math.min(OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH, ordered.length - offset);
  }
  if (policy.kind === "reference_batch") {
    return Math.min(policy.assertionsPerPack, ordered.length - offset);
  }
  let packed = 0;
  let packedChars = 0;
  while (offset + packed < ordered.length && packed < policy.maxAssertions) {
    const next = ordered[offset + packed]!;
    const nextChars = packedChars + next.text.length + 24;
    const inputTokens = estimateTokens(policy.systemPromptChars + 180 + nextChars);
    const expectedOut = 64 * (packed + 1);
    if (inputTokens > policy.maxInputTokens || expectedOut > policy.expectedOutputCap) break;
    packedChars = nextChars;
    packed += 1;
  }
  return packed;
}

function makePack(
  members: readonly PackableAssertion[],
  policyKind: TransportPackPolicy["kind"]
): TransportPack {
  const assertionIds = members.map((member) => member.assertionId);
  const semanticKeys = members.map((member) => member.semanticKey);
  const packId = createHash("sha256")
    .update(String(TRANSPORT_PACK_CONTRACT_VERSION), "utf8")
    .update("\u0000", "utf8")
    .update(policyKind, "utf8")
    .update("\u0000", "utf8")
    .update(semanticKeys.join("\n"), "utf8")
    .digest("hex");
  return Object.freeze({
    pack_id: packId,
    policy_kind: policyKind,
    assertion_ids: Object.freeze(assertionIds),
    semantic_keys: Object.freeze(semanticKeys)
  });
}

function emptyPack(policyKind: TransportPackPolicy["kind"]): TransportPack {
  return makePack([], policyKind);
}

export function unresolvedRetryMembers<T extends { readonly semanticKey: string }>(
  members: readonly T[],
  admittedKeys: ReadonlySet<string>
): readonly T[] {
  return Object.freeze(members.filter((member) => !admittedKeys.has(member.semanticKey)));
}

function freezePlan(
  packs: readonly TransportPack[],
  unpackable: readonly Readonly<{ semanticKey: string; assertionId: number; reason: "hard_cap_exceeded" }>[]
): TransportPackPlan {
  const inventoryDigest = createHash("sha256")
    .update(String(TRANSPORT_PACK_CONTRACT_VERSION), "utf8")
    .update("\u0000", "utf8")
    .update(packs.map((pack) => pack.pack_id).join("\n"), "utf8")
    .update("\u0000", "utf8")
    .update(unpackable.map((item) =>
      `${item.semanticKey}\u0000${item.assertionId}\u0000${item.reason}`
    ).join("\n"), "utf8")
    .digest("hex");
  return Object.freeze({
    inventory_digest: inventoryDigest,
    packs: Object.freeze([...packs]),
    unpackable: Object.freeze([...unpackable])
  });
}

function assertTransportPackPolicy(policy: TransportPackPolicy): void {
  if (policy.kind !== "token_aware") return;
  for (const [label, value] of Object.entries({
    maxAssertions: policy.maxAssertions,
    maxInputTokens: policy.maxInputTokens,
    expectedOutputCap: policy.expectedOutputCap,
    systemPromptChars: policy.systemPromptChars
  })) {
    if (!Number.isSafeInteger(value) || value < (label === "systemPromptChars" ? 0 : 1)) {
      throw new TypeError(`${label} must be a finite safe integer within its hard-cap domain`);
    }
  }
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
