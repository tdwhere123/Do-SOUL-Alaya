import { describe, expect, it } from "vitest";
import { hashLabeledIdentity } from "@do-soul/alaya-protocol";

import { createSelectedSliceKeyV2 } from
  "../../../recall/flood/slice-key-contract.js";
import { materializeSliceKeyL1Postings } from
  "../../../recall/flood/slice-key-l1-postings.js";
import { materializeSliceKeyL2Bundles } from
  "../../../recall/flood/slice-key-l2-bundles.js";
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

describe("pinned projection closed-bundle visibility", () => {
  it("keeps a closed matching bundle invisible once leftover opening budget is 0", () => {
    const artifacts = plantedClosedAdaArtifacts();
    // Visibility spends the query activation budget before matching.
    const condition = capture(["Ada"], 0);
    const selected = selectPinnedProjectionCandidates({
      condition,
      artifacts,
      sha256: testSha256()
    });

    expectClosedAdaBundle(artifacts);
    expectPinnedIdentities(selected, condition);
    expect(selected.candidate_keys).toEqual([]);
    expect(selected.stop.frontier).toBe("incomplete");
    expect(selected.stop.reason).toBe("activation_budget_exhausted");
    expect(selected.stop.selected_candidate_keys).toEqual([]);
  });

  it("makes the closed matching bundle visible only after this query opens it", () => {
    const artifacts = plantedClosedAdaArtifacts();
    const openedCondition = capture(["Ada"], 8);
    const exhaustedCondition = capture(["Ada"], 0);
    const opened = selectPinnedProjectionCandidates({
      condition: openedCondition,
      artifacts,
      sha256: testSha256()
    });
    const exhausted = selectPinnedProjectionCandidates({
      condition: exhaustedCondition,
      artifacts,
      sha256: testSha256()
    });

    expectClosedAdaBundle(artifacts);
    expectPinnedIdentities(opened, openedCondition);
    expectPinnedIdentities(exhausted, exhaustedCondition);
    expect(opened.candidate_keys).toEqual([HIDDEN]);
    expect(opened.stop.selected_candidate_keys).toEqual([HIDDEN]);
    expect(opened.stop.frontier).toBe("closed");
    expect(opened.stop.reason).toBe("all_channels_closed");
    expect(exhausted.candidate_keys).not.toContain(HIDDEN);
    expect(exhausted.stop.selected_candidate_keys).not.toContain(HIDDEN);
    expect(exhausted.stop.reason).toBe("activation_budget_exhausted");
  });

  it("keeps a closed matching member hidden even when an opened parent also lists it", () => {
    const artifacts = plantedClosedAdaArtifacts({ includeOpenedParent: true });
    const selected = selectPinnedProjectionCandidates({
      condition: capture(["Ada"], 0),
      artifacts,
      sha256: testSha256()
    });

    expect(artifacts.bundles.some((bundle) =>
      bundle.opened === true && bundle.member_refs.includes(HIDDEN)
    )).toBe(true);
    expect(selected.candidate_keys).toEqual([]);
  });
});

function plantedClosedAdaArtifacts(
  options: Readonly<{ readonly includeOpenedParent?: boolean }> = {}
) {
  const sha256 = testSha256();
  const keys = [groundedKey(HIDDEN, "ada")];
  const postings = materializeSliceKeyL1Postings(GENERATION_ID, keys, sha256);
  const closed = materializeSliceKeyL2Bundles({
    generationId: GENERATION_ID,
    postings,
    sha256,
    policy: POLICY,
    plantedFrontiers: [{
      anchor_digest: hashLabeledIdentity("bundle_anchor", [
        keys[0]!.dimension,
        keys[0]!.normalized_value
      ], sha256),
      unseen_gain_upper_bound: 0.9,
      opened: false
    }]
  });
  const parent = options.includeOpenedParent === true
    ? [Object.freeze({
      ...closed[0]!,
      bundle_id: `${closed[0]!.bundle_id}:parent`,
      level: 2,
      opened: true,
      child_bundle_ids: [closed[0]!.bundle_id]
    })]
    : [];
  return createProjectionGenerationArtifacts({
    generation_id: GENERATION_ID,
    postings,
    bundles: [...closed, ...parent],
    slice_keys: keys,
    policy: POLICY
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

function expectClosedAdaBundle(
  artifacts: ReturnType<typeof plantedClosedAdaArtifacts>
): void {
  const closed = artifacts.bundles.find((bundle) =>
    bundle.member_refs.includes(HIDDEN)
  );
  expect(closed?.opened).toBe(false);
  expect(closed?.factor_summary.some((factor) =>
    factor.dimension === "semantic" && factor.value === "ada"
  )).toBe(true);
}

function expectPinnedIdentities(
  selected: ReturnType<typeof selectPinnedProjectionCandidates>,
  condition: ReturnType<typeof capture>
): void {
  expect(selected.activation.generation_id).toBe(GENERATION_ID);
  expect(selected.activation.condition_digest).toBe(condition.identity);
  expect(selected.stop.generation_id).toBe(GENERATION_ID);
  expect(selected.stop.condition_digest).toBe(condition.identity);
}
