import { describe, expect, it } from "vitest";
import {
  FieldStopCertificateReceiptSchema,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";

import { createRecallFiniteFieldChannelCapture } from
  "../../../recall/field/finite-field-capture.js";
import {
  assertRecallFiniteFieldDoesNotClaimExhaustion,
  createRecallFiniteFieldSeal
} from "../../../recall/field/finite-field-seal.js";
import { createFieldStopCertificateEnvelope } from
  "../../../recall/field/refinement/field-refinement-stop-envelope.js";
import { materializeRetrievalL1Postings } from
  "../../../recall/field/retrieval/projection/l1-postings.js";
import { openProjectionBundlesProgressively } from
  "../../../recall/field/retrieval/projection/progressive-opening.js";
import { createProjectionBundleCache } from
  "../../../recall/field/retrieval/projection/bundle-cache.js";
import { createSelectedSliceKeyV2 } from "../../../recall/flood/slice-key-contract.js";
import {
  assertProjectionBundleLevelDag,
  materializeSliceKeyL2Bundles
} from "../../../recall/flood/slice-key-l2-bundles.js";
import { materializeSliceKeyL1Postings } from
  "../../../recall/flood/slice-key-l1-postings.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const sha256: FieldContractSha256 = fieldContractSha256;
const GENERATION = `sha256:${"a".repeat(64)}`;
const CONDITION = `sha256:${"b".repeat(64)}`;

describe("projection L1/L2 bundles and honest stop envelopes", () => {
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
    expect(() => assertProjectionBundleLevelDag(bundles)).not.toThrow();
    expect(bundles.some((bundle) =>
      bundle.member_refs.includes("memory-1") &&
      bundle.member_refs.includes("memory-2")
    )).toBe(true);
  });

  it("keeps a strict level DAG, allows overlap, and rejects mixed generations", () => {
    const postings = materializeSliceKeyL1Postings(GENERATION, [
      entityKey("memory-1"),
      timeKey("memory-1"),
      entityKey("memory-2"),
      timeKey("memory-2")
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

  it("plants a higher-bound unseen candidate and refuses exhaustion", () => {
    const postings = materializeSliceKeyL1Postings(GENERATION, [
      entityKey("memory-1")
    ], sha256);
    const bundles = materializeSliceKeyL2Bundles({
      generationId: GENERATION,
      postings,
      sha256,
      policy: { materialize: true, maxLevel: 1, maxMembers: 8, minMembers: 1 },
      plantedFrontiers: [{
        anchor_digest: digest("unseen-anchor"),
        unseen_gain_upper_bound: 0.9,
        opened: false
      }]
    });
    const envelope = createFieldStopCertificateEnvelope({
      workspace_id: "workspace-1",
      generation_id: GENERATION,
      condition_digest: CONDITION,
      recorded_at: CLOCK,
      sha256,
      selected_candidate_keys: ["memory-1"],
      bundleFrontiers: bundles.map((bundle) => ({
        unseen_gain_upper_bound: bundle.unseen_frontier_upper_bound,
        incumbent_loss: 0.1,
        opened: bundle.opened
      }))
    });
    const seal = createRecallFiniteFieldSeal({
      upstream_snapshot_digest: GENERATION,
      channel_catalog: ["test_channel"],
      channels: [{
        channel_id: "test_channel",
        status: "complete",
        depth: 1,
        observations: [{
          observation_id: "test:1",
          candidate_key: "memory-1",
          rank: 1
        }],
        unseen_upper_bound: 0
      }]
    });

    expect(bundles.some((bundle) =>
      bundle.opened === false && bundle.unseen_frontier_upper_bound === 0.9
    )).toBe(true);
    expect(envelope.status).toBe("uncertified");
    expect(envelope.frontier).toBe("incomplete");
    expect(envelope.reason).toBe("exchange_not_dominated");
    expect(envelope.operator_id).toBe("recall_field_selector_exchange_bound_v1");
    expect(envelope.improvement_upper_bound).toBeCloseTo(0.8, 12);
    expect(() => FieldStopCertificateReceiptSchema.parse(envelope)).not.toThrow();
    expect(() => assertRecallFiniteFieldDoesNotClaimExhaustion(seal, [0.9]))
      .toThrow(/exhaustion/u);
  });

  it("returns an explicit incomplete receipt when the activation budget ends first", () => {
    const opened = openProjectionBundlesProgressively({
      workspace_id: "workspace-1",
      generation_id: GENERATION,
      condition_digest: CONDITION,
      recorded_at: CLOCK,
      sha256,
      selected_candidate_keys: ["memory-1"],
      activationBudget: 0,
      frontiers: [{
        bundle_id: digest("bundle-high"),
        unseen_gain_upper_bound: 0.7,
        incumbent_loss: 0.1,
        opened: false
      }]
    });

    expect(opened.opened_bundle_ids).toEqual([]);
    expect(opened.stop.status).toBe("uncertified");
    expect(opened.stop.frontier).toBe("incomplete");
    expect(opened.stop.reason).toBe("activation_budget_exhausted");
    expect(opened.stop.reason).not.toBe("all_channels_closed");
    expect(() => FieldStopCertificateReceiptSchema.parse(opened.stop)).not.toThrow();
  });

  it("opens the highest-bound unopened bundle first and rejects a stale cache hit", () => {
    const opened = openProjectionBundlesProgressively({
      workspace_id: "workspace-1",
      generation_id: GENERATION,
      condition_digest: CONDITION,
      recorded_at: CLOCK,
      sha256,
      selected_candidate_keys: ["memory-1"],
      activationBudget: 1,
      frontiers: [
        {
          bundle_id: digest("bundle-low"),
          unseen_gain_upper_bound: 0.2,
          incumbent_loss: 0.1,
          opened: false
        },
        {
          bundle_id: digest("bundle-high"),
          unseen_gain_upper_bound: 0.8,
          incumbent_loss: 0.1,
          opened: false
        }
      ]
    });
    const cache = createProjectionBundleCache(sha256);
    cache.put({
      bundle: {
        bundle_id: digest("bundle-high"),
        generation_id: GENERATION,
        scope: "workspace-1",
        anchor_digest: digest("anchor"),
        level: 1,
        member_refs: ["memory-1"],
        child_bundle_ids: [],
        factor_summary: Object.freeze([]),
        support_lineages: Object.freeze([]),
        unseen_frontier_upper_bound: 0,
        opened: true,
        operator_id: "projection_generation_v1"
      },
      condition_digest: CONDITION,
      governance_frontier: "gov-1",
      erase_frontier: "erase-0"
    });

    expect(opened.opened_bundle_ids).toEqual([digest("bundle-high")]);
    expect(opened.stop.status).toBe("uncertified");
    expect(opened.stop.frontier).toBe("incomplete");
    expect(opened.stop.reason).toBe("activation_budget_exhausted");
    expect(opened.remaining.some((frontier) =>
      frontier.bundle_id === digest("bundle-low") && frontier.opened === false
    )).toBe(true);
    expect(() => cache.get({
      bundle_id: digest("bundle-high"),
      condition_digest: digest("other-condition"),
      generation_id: GENERATION,
      governance_frontier: "gov-1",
      erase_frontier: "erase-0"
    })).toThrow(/stale cache/u);
  });

  it("certifies a closed frontier only after every planted bundle is opened", () => {
    const closed = openProjectionBundlesProgressively({
      workspace_id: "workspace-1",
      generation_id: GENERATION,
      condition_digest: CONDITION,
      recorded_at: CLOCK,
      sha256,
      selected_candidate_keys: ["memory-1"],
      activationBudget: 2,
      frontiers: [
        {
          bundle_id: digest("bundle-low"),
          unseen_gain_upper_bound: 0.2,
          incumbent_loss: 0.1,
          opened: false
        },
        {
          bundle_id: digest("bundle-high"),
          unseen_gain_upper_bound: 0.8,
          incumbent_loss: 0.1,
          opened: false
        }
      ]
    });
    expect(closed.opened_bundle_ids).toHaveLength(2);
    expect(closed.stop.status).toBe("certified");
    expect(closed.stop.frontier).toBe("closed");
    expect(closed.stop.reason).toBe("all_channels_closed");
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

function digest(value: string) {
  return `sha256:${sha256(value)}`;
}
