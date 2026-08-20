import { describe, expect, it } from "vitest";
import {
  hashLabeledIdentity,
  PROJECTION_GENERATION_OPERATOR_ID
} from "@do-soul/alaya-protocol";

import { createSelectedSliceKeyV2 } from
  "../../../recall/flood/slice-key-contract.js";
import { materializeSliceKeyL1Postings } from
  "../../../recall/flood/slice-key-l1-postings.js";
import { type ProjectionL2Bundle } from "../../../recall/flood/slice-key-l2-bundles.js";
import { createProjectionGenerationArtifacts } from
  "../../../recall/field/retrieval/projection/generation-artifacts.js";
import { selectPinnedProjectionCandidates } from
  "../../../recall/field/retrieval/projection/pinned-projection-selection.js";
import { captureQueryCondition } from
  "../../../recall/query/condition/query-condition-capture.js";
import {
  conditionDraft,
  frozenClock,
  GENERATION_ID,
  testPin,
  testSha256
} from "../query/query-condition-test-fixtures.js";

const CLOCK_MS = Date.parse("2026-08-16T00:00:00.000Z");
const HIDDEN = "hidden-evidence";
const POLICY = Object.freeze({
  materialize: true,
  maxLevel: 1,
  maxMembers: 16,
  minMembers: 1
});

describe("pinned projection legal slice_key visibility", () => {
  it("admits the lower-unseen legal owner when a higher-unseen empty matching bundle is also closed", () => {
    const artifacts = twoMatchingClosedAdaArtifacts();
    const empty = artifacts.bundles.find((bundle) => bundle.member_refs.length === 0);
    const target = artifacts.bundles.find((bundle) =>
      bundle.member_refs.includes(HIDDEN)
    );
    const selected = selectPinnedProjectionCandidates({
      condition: capture(["Ada"], 1),
      artifacts,
      sha256: testSha256()
    });

    expect(empty?.opened).toBe(false);
    expect(target?.opened).toBe(false);
    expect(empty?.unseen_frontier_upper_bound)
      .toBeGreaterThan(target?.unseen_frontier_upper_bound ?? Number.POSITIVE_INFINITY);
    expect(empty?.factor_summary.some((factor) => factor.value === "ada")).toBe(true);
    expect(target?.factor_summary.some((factor) => factor.value === "ada")).toBe(true);
    expect(target?.member_refs).toEqual([HIDDEN]);
    expect(artifacts.slice_keys.map((key) => key.owner_id)).toEqual([HIDDEN]);
    expect(artifacts.slice_keys.every((key) => key.normalized_value === "ada")).toBe(true);
    expect(selected.candidate_keys).toEqual([HIDDEN]);
  });

  it("omits pre-Gamma visibility stop from the public selection result", () => {
    const selected = selectPinnedProjectionCandidates({
      condition: capture(["Ada"], 1),
      artifacts: twoMatchingClosedAdaArtifacts(),
      sha256: testSha256()
    });

    expect(Object.hasOwn(selected, "stop")).toBe(false);
  });

  it("keeps public candidate keys equal for opened and closed matching bundles at sufficient budget", () => {
    const opened = selectPinnedProjectionCandidates({
      condition: capture(["Ada"], 8),
      artifacts: singleMatchingAdaArtifacts(true),
      sha256: testSha256()
    });
    const closed = selectPinnedProjectionCandidates({
      condition: capture(["Ada"], 8),
      artifacts: singleMatchingAdaArtifacts(false),
      sha256: testSha256()
    });

    expect(opened.candidate_keys).toEqual([HIDDEN]);
    expect(closed.candidate_keys).toEqual(opened.candidate_keys);
  });
});

function twoMatchingClosedAdaArtifacts() {
  const keys = [groundedKey(HIDDEN, "ada")];
  return artifactsFromAdaKeys(keys, [
    matchingAdaBundle({
      bundle_id: "bundle-target",
      member_refs: [HIDDEN],
      unseen_frontier_upper_bound: 0.2,
      opened: false
    }),
    matchingAdaBundle({
      bundle_id: "bundle-empty",
      member_refs: [],
      unseen_frontier_upper_bound: 0.9,
      opened: false
    })
  ]);
}

function singleMatchingAdaArtifacts(opened: boolean) {
  const keys = [groundedKey(HIDDEN, "ada")];
  return artifactsFromAdaKeys(keys, [
    matchingAdaBundle({
      bundle_id: "bundle-target",
      member_refs: [HIDDEN],
      unseen_frontier_upper_bound: 0,
      opened
    })
  ]);
}

function artifactsFromAdaKeys(
  keys: readonly ReturnType<typeof groundedKey>[],
  bundles: readonly ProjectionL2Bundle[]
) {
  return createProjectionGenerationArtifacts({
    generation_id: GENERATION_ID,
    postings: materializeSliceKeyL1Postings(GENERATION_ID, keys, testSha256()),
    bundles,
    slice_keys: keys,
    policy: POLICY
  });
}

function matchingAdaBundle(input: Readonly<{
  readonly bundle_id: string;
  readonly member_refs: readonly string[];
  readonly unseen_frontier_upper_bound: number;
  readonly opened: boolean;
}>): ProjectionL2Bundle {
  return Object.freeze({
    bundle_id: input.bundle_id,
    generation_id: GENERATION_ID,
    scope: "workspace-1",
    anchor_digest: hashLabeledIdentity("bundle_anchor", [
      "semantic",
      "ada",
      input.bundle_id
    ], testSha256()),
    level: 1,
    member_refs: Object.freeze([...input.member_refs]),
    child_bundle_ids: Object.freeze([]),
    factor_summary: Object.freeze([
      Object.freeze({ dimension: "semantic", value: "ada" })
    ]),
    support_lineages: Object.freeze([...input.member_refs]),
    unseen_frontier_upper_bound: input.unseen_frontier_upper_bound,
    opened: input.opened,
    operator_id: PROJECTION_GENERATION_OPERATOR_ID
  });
}

function capture(queryTaskFactors: readonly string[], activationBudget: number) {
  return captureQueryCondition(conditionDraft({
    query_task_factors: queryTaskFactors,
    activation_budget: activationBudget
  }), {
    sha256: testSha256(),
    now: frozenClock(),
    pin: testPin()
  });
}

function groundedKey(ownerId: string, value: string) {
  return Object.freeze({
    ...createSelectedSliceKeyV2({
      workspace_id: "workspace-1",
      owner_id: ownerId,
      dimension: "semantic",
      value,
      authority: "grounded",
      reliability: 1,
      independence_group: "source-hidden",
      provenance: { kind: "signal_fact", source_ref: "span:source-hidden" },
      source_version: "source-v1",
      freshness: { state: "fresh", as_of_ms: CLOCK_MS }
    }),
    source_state: {
      scope: "workspace-1",
      event_time: null,
      valid_from: null,
      valid_to: null,
      lifecycle_state: "active" as const,
      governance_state: "ordinary_evidence" as const,
      sealed: false as const,
      erased: false as const,
      revoked: false as const,
      governance_effects: []
    }
  });
}
