import { describe, expect, it } from "vitest";

import { createSelectedSliceKeyV2 } from
  "../../../recall/flood/slice-key-contract.js";
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

describe("pinned source projection selection", () => {
  it("uses grounded factor receipts for membership and activation rank", () => {
    const condition = capture(["Ada Lovelace"]);
    const selected = selectPinnedProjectionCandidates({
      condition,
      artifacts: artifacts([
        sourceKey("evidence-full", "ada", "source-1"),
        sourceKey("evidence-full", "lovelace", "source-2"),
        sourceKey("evidence-partial", "ada", "source-3"),
        sourceKey("evidence-proposed", "ada", "source-4", "proposed_routing_only")
      ]),
      sha256: testSha256()
    });

    expect(selected.candidate_keys).toEqual([
      "evidence-full",
      "evidence-partial"
    ]);
    expect(selected.candidate_activation["evidence-full"])
      .toBeGreaterThan(selected.candidate_activation["evidence-partial"]!);
    expect(selected.candidate_receipts["evidence-full"]?.map((receipt) =>
      receipt.independence_group
    )).toEqual(["source-1", "source-2"]);
    expect(selected.activation.seed_ids).toHaveLength(3);
    expect(selected.activation.seed_ids.every((id) => id.startsWith("query-factor:")))
      .toBe(true);
  });

  it("changes membership when the query factor no longer matches", () => {
    const projection = artifacts([sourceKey("evidence-ada", "ada", "source-1")]);
    const matching = selectPinnedProjectionCandidates({
      condition: capture(["Ada"]),
      artifacts: projection,
      sha256: testSha256()
    });
    const counterfactual = selectPinnedProjectionCandidates({
      condition: capture(["Grace"]),
      artifacts: projection,
      sha256: testSha256()
    });

    expect(matching.candidate_keys).toEqual(["evidence-ada"]);
    expect(counterfactual.candidate_keys).toEqual([]);
  });

  it("applies governed effects at the query time instead of the build time", () => {
    const projection = artifacts([sourceKey(
      "evidence-ada",
      "ada",
      "source-1",
      "grounded",
      [{ action: "revoke", effective_as_of: "2026-08-17T00:00:00.000Z" }]
    )]);

    const historical = selectPinnedProjectionCandidates({
      condition: capture(["Ada"], "2026-08-16T00:00:00.000Z"),
      artifacts: projection,
      sha256: testSha256()
    });
    const revoked = selectPinnedProjectionCandidates({
      condition: capture(["Ada"], "2026-08-18T00:00:00.000Z"),
      artifacts: projection,
      sha256: testSha256()
    });

    expect(historical.candidate_keys).toEqual(["evidence-ada"]);
    expect(revoked.candidate_keys).toEqual([]);
  });
});

function capture(
  queryTaskFactors: readonly string[],
  effectiveAsOf = "2026-08-16T00:00:00.000Z"
) {
  return captureQueryCondition(conditionDraft({
    query_task_factors: queryTaskFactors,
    effective_as_of: effectiveAsOf
  }), {
    sha256: testSha256(),
    now: frozenClock(),
    pin: testPin()
  });
}

function artifacts(keys: readonly ReturnType<typeof sourceKey>[]) {
  return createProjectionGenerationArtifacts({
    generation_id: GENERATION_ID,
    postings: [],
    bundles: [],
    slice_keys: keys,
    policy: {
      materialize: false,
      maxLevel: 1,
      maxMembers: 16,
      minMembers: 2
    }
  });
}

function sourceKey(
  ownerId: string,
  value: string,
  independenceGroup: string,
  authority: "grounded" | "proposed_routing_only" = "grounded",
  governanceEffects: readonly Readonly<{
    action: "activate" | "revoke" | "seal" | "erase";
    effective_as_of: string;
  }>[] = []
) {
  return Object.freeze({
    ...createSelectedSliceKeyV2({
    workspace_id: "workspace-1",
    owner_id: ownerId,
    dimension: "semantic",
    value,
    authority,
    reliability: authority === "grounded" ? 1 : null,
    independence_group: independenceGroup,
    provenance: { kind: "signal_fact", source_ref: `span:${independenceGroup}` },
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
      governance_effects: governanceEffects
    }
  });
}
