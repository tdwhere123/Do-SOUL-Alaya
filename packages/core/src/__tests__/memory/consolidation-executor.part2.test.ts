import { describe, expect, it } from "vitest";
import { RuntimeGovernanceEventType } from "@do-soul/alaya-protocol";

import { MERGE_WHY_MAX_ENTRIES, buildHarness, createDormantLoser, createPath, emptyPlan } from "./consolidation-executor.test-support.js";

describe("ConsolidationExecutor", () => {
it("throws when a plan names a protected (evidence-rich) path as a merge loser, burning no budget", async () => {
    // The plan is externally constructable; a buggy/future caller could name a
    // protected path as a loser. The executor re-runs the importance gate at the
    // delete site and refuses — the protected path is never deleted.
    const survivor = createPath({ path_id: "path-survivor" });
    const protectedLoser = createDormantLoser({
      path_id: "path-protected",
      // evidence_basis length 2 => "keep" disposition => not deletable.
      legitimacy: { evidence_basis: ["ev-1", "ev-2"], governance_class: "recall_allowed" }
    });
    const harness = buildHarness({
      paths: [survivor, protectedLoser],
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-protected"] }]
        })
      })
    ).rejects.toThrow(/protected from deletion/);

    expect(harness.budgetUpserts).toHaveLength(0);
    expect(harness.repoDeletes).toHaveLength(0);
  });

it("throws when a plan names a strictly_governed path as a merge loser", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const governedLoser = createDormantLoser({
      path_id: "path-governed",
      legitimacy: { evidence_basis: ["ev-1"], governance_class: "strictly_governed" }
    });
    const harness = buildHarness({ paths: [survivor, governedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-governed"] }]
        })
      })
    ).rejects.toThrow(/protected from deletion/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

it("throws when a plan names a pinned path as a merge loser", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const pinnedLoser = createDormantLoser({
      path_id: "path-pinned",
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: "pinned",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({ paths: [survivor, pinnedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-pinned"] }]
        })
      })
    ).rejects.toThrow(/protected from deletion/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

it("throws when a merge loser is no longer dormant at apply time (TOCTOU guard)", async () => {
    // The loser is deletable by the gate (mergeable) but its lifecycle.status is
    // active, not dormant — it revived between plan emission and commit. The
    // dormant-at-apply re-check refuses the delete.
    const survivor = createPath({ path_id: "path-survivor" });
    const revivedLoser = createPath({
      path_id: "path-revived",
      lifecycle: { retirement_rule: "default", status: "active" }
    });
    const harness = buildHarness({ paths: [survivor, revivedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-revived"] }]
        })
      })
    ).rejects.toThrow(/no longer dormant/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

it("throws when a survivor is itself protected (not survivor-eligible)", async () => {
    const protectedSurvivor = createPath({
      path_id: "path-survivor",
      legitimacy: { evidence_basis: ["ev-1"], governance_class: "strictly_governed" }
    });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const harness = buildHarness({ paths: [protectedSurvivor, loser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
        })
      })
    ).rejects.toThrow(/not survivor-eligible/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

it("throws when a path is both a merge survivor and a loser in another merge, burning no budget", async () => {
    const shared = createPath({ path_id: "path-shared" });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const otherSurvivor = createPath({ path_id: "path-other" });
    const harness = buildHarness({
      paths: [shared, loser, otherSurvivor],
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [
            { survivor_path_id: "path-shared", merged_path_ids: ["path-loser"] },
            { survivor_path_id: "path-other", merged_path_ids: ["path-shared"] }
          ]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.budgetUpserts).toHaveLength(0);
    expect(harness.repoDeletes).toHaveLength(0);
  });

it("throws when the same loser appears in two merges", async () => {
    const survivorA = createPath({ path_id: "path-survivor-a" });
    const survivorB = createPath({ path_id: "path-survivor-b" });
    const sharedLoser = createDormantLoser({ path_id: "path-loser" });
    const harness = buildHarness({ paths: [survivorA, survivorB, sharedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [
            { survivor_path_id: "path-survivor-a", merged_path_ids: ["path-loser"] },
            { survivor_path_id: "path-survivor-b", merged_path_ids: ["path-loser"] }
          ]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

it("throws when a path appears in both a merge and the retirements list", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const harness = buildHarness({ paths: [survivor, loser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          retirements: [{ path_id: "path-loser", reason: "stale" }],
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

it("captures each deleted loser's full why/evidence/effect in PATH_RELATION_MERGED beyond the survivor bound", async () => {
    // R2/R3 regression guard: the survivor row is bounded, but the event is the
    // ONLY durable record of the destroyed losers, so it must carry each loser's
    // FULL why + evidence (even the entries dropped past the survivor bound) plus
    // an effect summary that distinguishes a negative-family (suppressing) loser.
    const survivorWhy = Array.from({ length: 12 }, (_, index) => `survivor-why-${index}`);
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: { relation_kind: "supports", why_this_relation_exists: survivorWhy }
    });
    const loserWhy = Array.from({ length: 20 }, (_, index) => `loser-why-${index}`);
    // A single evidence source keeps the loser "mergeable" (deletable); the
    // event still records the loser's full evidence_basis regardless of length.
    const loserEvidence = ["loser-ev-0"];
    const negativeLoser = createDormantLoser({
      path_id: "path-loser",
      constitution: { relation_kind: "supports", why_this_relation_exists: loserWhy },
      legitimacy: { evidence_basis: loserEvidence, governance_class: "recall_allowed" },
      effect_vector: {
        salience: 0.2,
        recall_bias: -0.8,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      plasticity_state: {
        strength: 0.5,
        direction_bias: "target_to_source",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({ paths: [survivor, negativeLoser] });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    // The survivor row is bounded — its absorbed loser entries were trimmed.
    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    const survivorMergedWhy =
      survivorUpdate?.updates.constitution?.why_this_relation_exists ?? [];
    expect(survivorMergedWhy.length).toBe(MERGE_WHY_MAX_ENTRIES);
    // Some loser why entries did NOT fit into the bounded survivor row.
    const absorbedLoserWhy = survivorMergedWhy.filter((entry) => entry.startsWith("loser-why-"));
    expect(absorbedLoserWhy.length).toBeLessThan(loserWhy.length);

    // The event is the durable record: it carries the loser's FULL why/evidence,
    // including the entries the survivor row could not absorb.
    const mergedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_MERGED
    );
    expect(mergedEvents).toHaveLength(1);
    const mergedPayload = mergedEvents[0]?.payload_json as Record<string, unknown>;
    const mergedLosers = mergedPayload.merged_losers as readonly Record<string, unknown>[];
    expect(mergedLosers).toHaveLength(1);
    const recorded = mergedLosers[0]!;
    expect(recorded.path_id).toBe("path-loser");
    expect(recorded.why_this_relation_exists).toEqual(loserWhy);
    expect(recorded.evidence_basis).toEqual(loserEvidence);
    expect(recorded.recall_bias_sign).toBe("negative");
    expect(recorded.recall_bias_magnitude).toBeCloseTo(0.8);
    expect(recorded.direction_bias).toBe("target_to_source");
  });
});
