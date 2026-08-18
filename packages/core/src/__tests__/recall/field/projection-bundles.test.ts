import { describe, expect, it } from "vitest";
import { type FieldContractSha256 } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";

import { createRecallFiniteFieldChannelCapture } from
  "../../../recall/field/finite-field-capture.js";
import { materializeRetrievalL1Postings } from
  "../../../recall/field/retrieval/projection/l1-postings.js";
import { createSelectedSliceKeyV2 } from "../../../recall/flood/slice-key-contract.js";
import {
  assertProjectionBundleLevelDag,
  materializeSliceKeyL2Bundles
} from "../../../recall/flood/slice-key-l2-bundles.js";
import { materializeSliceKeyL1Postings } from
  "../../../recall/flood/slice-key-l1-postings.js";

const sha256: FieldContractSha256 = fieldContractSha256;
const GENERATION = `sha256:${"a".repeat(64)}`;

describe("projection L1/L2 bundles", () => {
  it("always materializes L1 postings and only selectively materializes L2", () => {
    const keys = [entityKey("memory-1"), timeKey("memory-1"), entityKey("memory-2")];
    const postings = materializeSliceKeyL1Postings(GENERATION, keys, sha256);
    const skipped = materializeSliceKeyL2Bundles({
      generationId: GENERATION,
      postings,
      sha256,
      policy: { materialize: false, maxLevel: 2, maxMembers: 8, minMembers: 1 }
    });
    const bundles = materializeSliceKeyL2Bundles({
      generationId: GENERATION,
      postings,
      sha256,
      policy: { materialize: true, maxLevel: 2, maxMembers: 8, minMembers: 1 }
    });

    expect(postings.length).toBeGreaterThan(0);
    expect(postings.every((posting) => posting.generation_id === GENERATION)).toBe(true);
    expect(skipped).toEqual([]);
    expect(bundles.length).toBeGreaterThan(0);
    expect(bundles.every((bundle) =>
      bundle.opened === true && bundle.unseen_frontier_upper_bound === 0
    )).toBe(true);
    expect(() => assertProjectionBundleLevelDag(bundles)).not.toThrow();
    expect(bundles.some((bundle) =>
      bundle.member_refs.includes("memory-1") &&
      bundle.member_refs.includes("memory-2")
    )).toBe(true);
  });

  it("keeps a strict level DAG, allows overlap, and rejects mixed generations", () => {
    const postings = materializeSliceKeyL1Postings(GENERATION, [
      identityKey("memory-1", "entity", "Ada Lovelace", "canonical_entity"),
      identityKey("memory-1", "time", "day:2026-08-16", "event_time"),
      identityKey("memory-2", "entity", "Ada Lovelace", "canonical_entity"),
      identityKey("memory-2", "time", "day:2026-08-16", "event_time")
    ], sha256);
    const other = materializeSliceKeyL1Postings(`sha256:${"c".repeat(64)}`, [
      entityKey("memory-3")
    ], sha256);
    const bundles = materializeSliceKeyL2Bundles({
      generationId: GENERATION,
      postings,
      sha256,
      policy: { materialize: true, maxLevel: 2, maxMembers: 8, minMembers: 1 }
    });
    const parents = bundles.filter((bundle) => bundle.level === 2);
    const children = new Set(bundles.filter((bundle) => bundle.level === 1)
      .map((bundle) => bundle.bundle_id));

    expect(parents.length).toBeGreaterThan(0);
    expect(parents.every((bundle) =>
      bundle.child_bundle_ids.every((childId) => children.has(childId))
    )).toBe(true);
    expect(postings.filter((posting) => posting.member_ref === "memory-1").length)
      .toBeGreaterThan(1);
    expect(() => materializeSliceKeyL2Bundles({
      generationId: GENERATION,
      postings: [...postings, ...other],
      sha256,
      policy: { materialize: true, maxLevel: 2, maxMembers: 8, minMembers: 1 }
    })).toThrow(/mixed generation/u);
    expect(() => assertProjectionBundleLevelDag([{
      ...bundles[0]!,
      level: 2,
      child_bundle_ids: [bundles[0]!.bundle_id]
    }])).toThrow(/level DAG/u);
  });

  it("keeps grounded co-membered L1 bundles without pairing them at L2", () => {
    const postings = materializeSliceKeyL1Postings(GENERATION, [
      groundedKey("memory-1", "some"),
      groundedKey("memory-1", "have")
    ], sha256);
    const bundles = materializePolicyBundles(postings);
    const levelOne = bundles.filter((bundle) => bundle.level === 1);

    expect(levelOne).toHaveLength(2);
    expect(levelOne.every((bundle) => bundle.member_refs.includes("memory-1"))).toBe(true);
    expect(bundles.some((bundle) => bundle.level === 2)).toBe(false);
  });

  it("pairs L2 only when both co-membered L1 anchors are identity", () => {
    const identity = materializePolicyBundles(materializeSliceKeyL1Postings(GENERATION, [
      identityKey("memory-1", "semantic", "graduate", "signal_fact"),
      identityKey("memory-1", "semantic", "student", "signal_fact")
    ], sha256));
    const mixed = materializePolicyBundles(materializeSliceKeyL1Postings(GENERATION, [
      groundedKey("memory-1", "some"),
      identityKey("memory-1", "semantic", "graduate", "signal_fact")
    ], sha256));

    expect(identity.filter((bundle) => bundle.level === 1)).toHaveLength(2);
    expect(identity.filter((bundle) => bundle.level === 2)).toHaveLength(1);
    expect(mixed.filter((bundle) => bundle.level === 1)).toHaveLength(2);
    expect(mixed.some((bundle) => bundle.level === 2)).toBe(false);
  });

  it("pairs identity L2 among grounded co-members without dropping the identity pair", () => {
    const postings = materializeSliceKeyL1Postings(GENERATION, [
      groundedKey("memory-1", "some"),
      groundedKey("memory-1", "have"),
      groundedKey("memory-1", "how"),
      groundedKey("memory-1", "think"),
      identityKey("memory-1", "semantic", "graduate", "signal_fact"),
      identityKey("memory-1", "semantic", "student", "signal_fact")
    ], sha256);
    const bundles = materializePolicyBundles(postings);
    expect(bundles.filter((bundle) => bundle.level === 1)).toHaveLength(6);
    expect(bundles.filter((bundle) => bundle.level === 2)).toHaveLength(1);
  });

  it("turns retrieval-field observations into generation-scoped L1 postings", () => {
    const capture = createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: GENERATION,
      channel: {
        channel_id: "lexical_relaxed_exact",
        status: "truncated",
        depth: 1,
        unseen_upper_bound: 0.4,
        observations: [{
          observation_id: "lex:memory-1",
          candidate_key: "workspace_local:memory_entry:memory-1",
          rank: 1
        }]
      }
    });
    const postings = materializeRetrievalL1Postings(GENERATION, [capture], sha256);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      generation_id: GENERATION,
      source: "retrieval_channel",
      member_ref: "workspace_local:memory_entry:memory-1",
      dimension: "lexical"
    });
  });
});

function entityKey(ownerId: string) {
  return createSelectedSliceKeyV2({
    workspace_id: "workspace-1",
    owner_id: ownerId,
    dimension: "entity",
    value: "Ada Lovelace",
    authority: "grounded",
    reliability: 1,
    independence_group: `memory:${ownerId}`,
    provenance: { kind: "canonical_entity", source_ref: `entity:${ownerId}` },
    source_version: "projection:1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  });
}

function timeKey(ownerId: string) {
  return createSelectedSliceKeyV2({
    workspace_id: "workspace-1",
    owner_id: ownerId,
    dimension: "time",
    value: "day:2026-08-16",
    authority: "grounded",
    reliability: 1,
    independence_group: `memory:${ownerId}`,
    provenance: { kind: "event_time", source_ref: `event-time:${ownerId}` },
    source_version: "projection:1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  });
}

function groundedKey(ownerId: string, value: string) {
  return createSelectedSliceKeyV2({
    workspace_id: "workspace-1",
    owner_id: ownerId,
    dimension: "semantic",
    value,
    authority: "grounded",
    reliability: 1,
    independence_group: `memory:${ownerId}`,
    provenance: { kind: "signal_fact", source_ref: `span:${ownerId}` },
    source_version: "projection:1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  });
}

function identityKey(
  ownerId: string,
  dimension: "entity" | "time" | "semantic",
  value: string,
  kind: "canonical_entity" | "event_time" | "signal_fact"
) {
  return createSelectedSliceKeyV2({
    workspace_id: "workspace-1",
    owner_id: ownerId,
    dimension,
    value,
    authority: "proposed_routing_only",
    reliability: null,
    independence_group: `memory:${ownerId}`,
    provenance: { kind, source_ref: `${dimension}:${ownerId}` },
    source_version: "projection:1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  });
}

function materializePolicyBundles(
  postings: ReturnType<typeof materializeSliceKeyL1Postings>
) {
  return materializeSliceKeyL2Bundles({
    generationId: GENERATION,
    postings,
    sha256,
    policy: { materialize: true, maxLevel: 2, maxMembers: 8, minMembers: 1 }
  });
}
