import { describe, expect, it } from "vitest";
import { RuntimeGovernanceEventType, type PathRelation } from "@do-soul/alaya-protocol";
import { PATH_PLASTICITY_CONSTANTS } from "../../path-plasticity/index.js";
import {
  NOW_ISO,
  PAST_REINFORCED_ISO,
  buildHarness,
  createPath,
  createUsageRecord
} from "./path-plasticity-service-test-fixtures.js";

describe("PathPlasticityService dormant lifecycle (active <-> dormant + revive)", () => {
  const POSITIVE_FAMILY_BIAS = 0.3;
  const NEGATIVE_FAMILY_BIAS = -0.4;

  function positiveFamilyEffectVector(salience: number): PathRelation["effect_vector"] {
    return {
      salience,
      recall_bias: POSITIVE_FAMILY_BIAS,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    };
  }

  it("goes dormant (not retired) when a positive-associative path decays to the threshold while inactive: salience cleared, row kept (not deleted)", async () => {
    const path = createPath({
      effect_vector: positiveFamilyEffectVector(0.5),
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [path] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.dormant).toBe(1);
    expect(result.retired).toBe(0);
    expect(result.weakened).toBe(0);

    // The skip decays strength 0.05 -> 0; the path then goes dormant at that
    // decayed strength (dormant does not invent a separate strength value).
    const dormantEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_DORMANT
    );
    expect(dormantEvent).toBeDefined();
    expect(dormantEvent?.payload_json).toMatchObject({
      path_id: "path-1",
      dormancy_reason: "strength_below_threshold_and_inactive",
      dormant_strength: 0,
      dormant_at: NOW_ISO
    });

    // status flips to dormant, salience cleared, row retained (update, not delete).
    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "dormant" });
    expect(harness.repoUpdates[0]?.updates.effect_vector).toMatchObject({ salience: 0 });
    // strength reflects the post-decay value; the row is updated in place, never deleted.
    expect(harness.repoUpdates[0]?.updates.plasticity_state?.strength).toBe(0);
    // The path row still exists in the repo state after dormancy (kept in DB).
    expect(harness.getPath("path-1")).toBeDefined();
    expect(harness.getPath("path-1")?.lifecycle.status).toBe("dormant");
  });

  it("revives a dormant positive path back to active on a used receipt: strength reset to REVIVE_STRENGTH, salience restored, revived audit event", async () => {
    const dormantPath = createPath({
      effect_vector: positiveFamilyEffectVector(0),
      lifecycle: {
        status: "dormant",
        retirement_rule: "default"
      } as unknown as PathRelation["lifecycle"],
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 1,
        contradiction_events_count: 0,
        last_weakened_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ used_object_ids: ["obj-target"] })],
      pathsByObjectId: { "obj-target": [dormantPath] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.revived).toBe(1);
    expect(result.reinforced).toBe(0);

    const revivedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REVIVED
    );
    expect(revivedEvent).toBeDefined();
    expect(revivedEvent?.payload_json).toMatchObject({
      path_id: "path-1",
      revive_trigger: "used_receipt",
      previous_strength: 0.05,
      new_strength: PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH,
      revived_at: NOW_ISO
    });

    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "active" });
    expect(harness.repoUpdates[0]?.updates.plasticity_state?.strength).toBe(
      PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH
    );
    // salience restored to the revive strength so the path re-enters recall.
    expect(harness.repoUpdates[0]?.updates.effect_vector).toMatchObject({
      salience: PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH
    });
  });

  it("does NOT revive a dormant path on a skipped-only receipt (no used signal)", async () => {
    const dormantPath = createPath({
      effect_vector: positiveFamilyEffectVector(0),
      lifecycle: {
        status: "dormant",
        retirement_rule: "default"
      } as unknown as PathRelation["lifecycle"],
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_weakened_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [dormantPath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.revived).toBe(0);
    // A dormant path is not re-retired/re-dormant by a skip; it remains dormant.
    const revivedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REVIVED
    );
    expect(revivedEvent).toBeUndefined();
    expect(harness.getPath("path-1")?.lifecycle.status).toBe("dormant");
  });

  it("retires (NOT dormant) a negative-family path that decays to the threshold while inactive", async () => {
    const negativePath = createPath({
      effect_vector: {
        salience: 0.5,
        recall_bias: NEGATIVE_FAMILY_BIAS,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [negativePath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    // Negative family follows the existing terminal-retire path, never dormant.
    expect(result.retired).toBe(1);
    expect(result.dormant).toBe(0);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "retired" });
    const dormantEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_DORMANT
    );
    expect(dormantEvent).toBeUndefined();
  });

  it("preserves legacy neutral-default retire semantics: a recall_bias=0 path still retires (not dormant)", async () => {
    // invariant: recall_bias === 0 is neutral (not positive-associative) so it
    // keeps the terminal-retire path; the createPath default uses recall_bias 0.
    const neutralPath = createPath({
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO
      }
    });
    expect(neutralPath.effect_vector.recall_bias).toBe(0);
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [neutralPath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.retired).toBe(1);
    expect(result.dormant).toBe(0);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "retired" });
  });
});
