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
  const ordered = [...assertions].sort((left, right) => left.assertionId - right.assertionId);
  const packs: TransportPack[] = [];
  if (ordered.length === 0) {
    return freezePlan([emptyPack(policy.kind)]);
  }
  let offset = 0;
  while (offset < ordered.length) {
    const packed = nextPackSlice(ordered, offset, policy);
    packs.push(makePack(ordered.slice(offset, offset + packed), policy.kind));
    offset += packed;
  }
  return freezePlan(packs);
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
  const admittedKeys: string[] = [];
  const rejections: DemultiplexRejection[] = [];
  const seen = new Set<string>();
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
    const resolved = key ?? pack.semantic_keys[pack.assertion_ids.indexOf(assertionId!)];
    if (resolved === undefined) {
      rejections.push({ reason: "ambiguous", assertionId });
      continue;
    }
    if (seen.has(resolved)) {
      rejections.push({ reason: "duplicate", semanticKey: resolved });
      continue;
    }
    seen.add(resolved);
    admittedKeys.push(resolved);
  }
  return Object.freeze({
    admittedKeys: Object.freeze(admittedKeys),
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
  let packed = 0;
  let packedChars = 0;
  while (offset + packed < ordered.length && packed < policy.maxAssertions) {
    const next = ordered[offset + packed]!;
    const nextChars = packedChars + next.text.length + 24;
    const inputTokens = estimateTokens(policy.systemPromptChars + 180 + nextChars);
    const expectedOut = Math.min(policy.expectedOutputCap, 64 * (packed + 1));
    if (packed > 0 && (inputTokens > policy.maxInputTokens || expectedOut > policy.expectedOutputCap)) {
      break;
    }
    packedChars = nextChars;
    packed += 1;
  }
  return Math.max(1, packed);
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

function freezePlan(packs: readonly TransportPack[]): TransportPackPlan {
  const inventoryDigest = createHash("sha256")
    .update(packs.map((pack) => pack.pack_id).join("\n"), "utf8")
    .digest("hex");
  return Object.freeze({
    inventory_digest: inventoryDigest,
    packs: Object.freeze([...packs])
  });
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
