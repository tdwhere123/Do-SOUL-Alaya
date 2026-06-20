import { describe, expect, it } from "vitest";
import { RuntimeGovernanceEventType } from "@do-soul/alaya-protocol";

import { MERGE_WHY_MAX_ENTRIES, NOW_ISO, buildHarness, createDormantLoser, createPath, emptyPlan } from "./consolidation-executor.test-support.js";

describe("ConsolidationExecutor", () => {
it("applies planned PathRelation mutations and emits PATH_CONSOLIDATION_COMPLETED", async () => {
    const promotePath = createPath({ path_id: "path-promote" });
    const retirePath = createPath({ path_id: "path-retire" });
    const governPath = createPath({ path_id: "path-govern" });
    const directPath = createPath({ path_id: "path-direct" });
    const harness = buildHarness({
      paths: [promotePath, retirePath, governPath, directPath]
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        promotions: [
          { path_id: "path-promote", from_stability: "normal", to_stability: "stable" }
        ],
        retirements: [{ path_id: "path-retire", reason: "stale" }],
        governance_changes: [
          { path_id: "path-govern", from_class: "recall_allowed", to_class: "strictly_governed" }
        ],
        direction_changes: [
          {
            path_id: "path-direct",
            from_bias: "source_to_target",
            to_bias: "target_to_source"
          }
        ]
      })
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(result.promotions_committed).toBe(1);
    expect(result.retirements_committed).toBe(1);
    expect(result.governance_changes_committed).toBe(1);
    expect(result.direction_changes_committed).toBe(1);

    const byPath = new Map(harness.repoUpdates.map((row) => [row.pathId, row.updates]));
    expect(byPath.get("path-promote")?.plasticity_state?.stability_class).toBe("stable");
    expect(byPath.get("path-retire")?.lifecycle?.status).toBe("retired");
    expect(byPath.get("path-govern")?.legitimacy?.governance_class).toBe("strictly_governed");
    expect(byPath.get("path-direct")?.plasticity_state?.direction_bias).toBe("target_to_source");

    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
      )
    ).toBe(true);
  });

it("charges an attempt against the budget for every committed cycle", async () => {
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    // The prior window (cooldown_until in the past) has elapsed, so the
    // committed cycle restarts the rolling counter at 1 rather than climbing.
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
  });

it("refuses with cooldown_active and persists cooldown when the budget is cooling", async () => {
    // A maxed budget whose cooldown window is still open: the cooldown gate
    // refuses re-entry. This is the in-window backpressure path.
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 3,
        cooldown_until: "2999-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        promotions: [
          { path_id: "path-1", from_stability: "normal", to_stability: "stable" }
        ]
      })
    });

    expect(result.fuse_outcome).toBe("cooldown_active");
    expect(result.promotions_committed).toBe(0);
    expect(harness.repoUpdates).toHaveLength(0);
    const fused = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED
    );
    expect(fused).toBeDefined();
    // The cooldown is persisted so a follow-up cycle stays gated.
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(Date.parse(harness.budgetUpserts[0]!.cooldown_until)).toBeGreaterThan(
      Date.parse(NOW_ISO)
    );
  });

it("throws a clear error when a cooldown budget row is missing a valid timestamp", async () => {
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 3,
        cooldown_until: ""
      }
    });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan()
      })
    ).rejects.toThrow("Consolidation budget row is missing a valid cooldown_until timestamp.");
  });

it("recovers a maxed budget once its cooldown window has elapsed", async () => {
    // The B2 regression guard: a budget at the cap whose cooldown lapsed must
    // NOT stay fused. The window has elapsed, so the cycle commits and the
    // counter restarts — the trigger source is not wedged permanently.
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 3,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED
      )
    ).toBe(false);
  });

it("refuses the cycle while the budget cooldown is still active", async () => {
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 0,
        cooldown_until: "2999-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    expect(result.fuse_outcome).toBe("cooldown_active");
    expect(harness.repoUpdates).toHaveLength(0);
  });

it("does not charge within an unexpired window — the cooldown gate refuses first", async () => {
    // Cooldown is in the future: the window has NOT elapsed. The cooldown
    // gate refuses the cycle before any charge, so the counter is not reset
    // and not incremented by a committed cycle.
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "2999-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    expect(result.fuse_outcome).toBe("cooldown_active");
    // The only upsert is the cooldown refresh from refuse(); attempts_used is
    // carried unchanged (not reset to 1, not incremented).
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
  });

it("charges the budget only after the cycle commits", async () => {
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    // A single charge, and it carries the post-window-reset value (1).
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
    // The completed event was published before the budget charge committed.
    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
      )
    ).toBe(true);
  });

it("does not burn budget when the cycle's path mutation fails", async () => {
    // A plan that references a missing path makes prepareMutations throw
    // before the transaction; the budget must not be charged.
    const harness = buildHarness({
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
          promotions: [
            { path_id: "missing-path", from_stability: "normal", to_stability: "stable" }
          ]
        })
      })
    ).rejects.toThrow(/missing path relation/);

    // No attempt was charged — a failed cycle leaves the budget untouched.
    expect(harness.budgetUpserts).toHaveLength(0);
    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
      )
    ).toBe(false);
  });

it("honors a plan that arrives with the fuse already blown", async () => {
    const harness = buildHarness({});

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        fuse_state: { blown: true, reason: "planner abandoned cycle", retry_count: 2 }
      })
    });

    expect(result.fuse_outcome).toBe("tripped");
    expect(harness.repoUpdates).toHaveLength(0);
  });

it("applies a merge: concats survivor why (deduped), deletes losers, emits PATH_RELATION_MERGED", async () => {
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["survivor-why", "shared-why"]
      },
      legitimacy: { evidence_basis: ["ev-survivor"], governance_class: "recall_allowed" }
    });
    const loserA = createDormantLoser({
      path_id: "path-loser-a",
      constitution: {
        relation_kind: "supports",
        // "shared-why" duplicates the survivor's; "loser-a-why" is new.
        why_this_relation_exists: ["shared-why", "loser-a-why"]
      },
      legitimacy: { evidence_basis: ["ev-loser-a"], governance_class: "recall_allowed" }
    });
    const loserB = createDormantLoser({
      path_id: "path-loser-b",
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["loser-b-why"]
      },
      // evidence_basis length 1 keeps this loser "mergeable" (deletable); a
      // second source from the survivor still lands in the survivor's absorbed
      // evidence list.
      legitimacy: { evidence_basis: ["ev-loser-b"], governance_class: "recall_allowed" }
    });
    const harness = buildHarness({ paths: [survivor, loserA, loserB] });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [
          {
            survivor_path_id: "path-survivor",
            merged_path_ids: ["path-loser-a", "path-loser-b"]
          }
        ]
      })
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(result.merges_committed).toBe(1);

    // Survivor's why_this_relation_exists is survivor-first, deduped union.
    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    expect(survivorUpdate?.updates.constitution?.why_this_relation_exists).toEqual([
      "survivor-why",
      "shared-why",
      "loser-a-why",
      "loser-b-why"
    ]);
    // Survivor absorbs losers' evidence too (survivor-first, deduped union).
    expect(survivorUpdate?.updates.legitimacy?.evidence_basis).toEqual([
      "ev-survivor",
      "ev-loser-a",
      "ev-loser-b"
    ]);

    // Losers are deleted; survivor is not.
    expect(harness.repoDeletes.sort()).toEqual(["path-loser-a", "path-loser-b"]);
    expect(harness.pathStateById.has("path-survivor")).toBe(true);
    expect(harness.pathStateById.has("path-loser-a")).toBe(false);
    expect(harness.pathStateById.has("path-loser-b")).toBe(false);

    // One merged audit event carries the losers and the survivor relation kind.
    const mergedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_MERGED
    );
    expect(mergedEvents).toHaveLength(1);
    const mergedPayload = mergedEvents[0]?.payload_json as Record<string, unknown>;
    expect(mergedPayload.survivor_path_id).toBe("path-survivor");
    expect(mergedPayload.merged_path_ids).toEqual(["path-loser-a", "path-loser-b"]);
    expect(mergedPayload.relation_kind).toBe("supports");

    // The completed event counts the deleted losers toward paths_retired.
    const completed = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
    );
    expect((completed?.payload_json as Record<string, unknown>).paths_retired).toBe(2);
  });

it("merges in the same transaction as other mutations and charges one attempt", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const promote = createPath({ path_id: "path-promote" });
    const harness = buildHarness({ paths: [survivor, loser, promote] });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        promotions: [{ path_id: "path-promote", from_stability: "normal", to_stability: "stable" }],
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(result.promotions_committed).toBe(1);
    expect(result.merges_committed).toBe(1);
    expect(harness.repoDeletes).toEqual(["path-loser"]);
    // A single budget charge for the whole cycle.
    expect(harness.budgetUpserts).toHaveLength(1);
  });

it("bounds the concatenated survivor why to the configured max entries", async () => {
    // Build a survivor + loser whose combined unique why entries exceed the
    // DYNAMICS_CONSTANTS bound; the survivor's own entries are always kept.
    const survivorWhy = Array.from({ length: 4 }, (_, index) => `survivor-why-${index}`);
    const loserWhy = Array.from({ length: 40 }, (_, index) => `loser-why-${index}`);
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: { relation_kind: "supports", why_this_relation_exists: survivorWhy }
    });
    const loser = createDormantLoser({
      path_id: "path-loser",
      constitution: { relation_kind: "supports", why_this_relation_exists: loserWhy }
    });
    const harness = buildHarness({ paths: [survivor, loser] });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    const mergedWhy = survivorUpdate?.updates.constitution?.why_this_relation_exists ?? [];
    expect(mergedWhy.length).toBe(MERGE_WHY_MAX_ENTRIES);
    // Survivor's own entries lead and are never trimmed.
    expect(mergedWhy.slice(0, survivorWhy.length)).toEqual(survivorWhy);
  });

it("rejects a merge whose survivor lists itself as a loser, burning no budget", async () => {
    // Survivor-also-loser is an id overlap (path-survivor in both lanes), caught
    // by the overlap guard before any path is loaded.
    const survivor = createPath({ path_id: "path-survivor" });
    const harness = buildHarness({
      paths: [survivor],
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
            { survivor_path_id: "path-survivor", merged_path_ids: ["path-survivor"] }
          ]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.budgetUpserts).toHaveLength(0);
    expect(harness.repoDeletes).toHaveLength(0);
  });

it("keeps the full survivor why/evidence when the survivor alone exceeds the bound", async () => {
    // C2 regression guard: the bound caps only ABSORBED loser entries. A
    // survivor whose own why/evidence already holds more than the bound must
    // emerge untrimmed — the survivor never loses its own provenance.
    const overBound = MERGE_WHY_MAX_ENTRIES + 4;
    const survivorWhy = Array.from({ length: overBound }, (_, index) => `survivor-why-${index}`);
    const survivorEvidence = Array.from(
      { length: overBound },
      (_, index) => `survivor-ev-${index}`
    );
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: { relation_kind: "supports", why_this_relation_exists: survivorWhy },
      legitimacy: { evidence_basis: survivorEvidence, governance_class: "recall_allowed" }
    });
    const loser = createDormantLoser({
      path_id: "path-loser",
      constitution: { relation_kind: "supports", why_this_relation_exists: ["loser-why"] }
    });
    const harness = buildHarness({ paths: [survivor, loser] });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    // The survivor's own oversized list is preserved in full (length === overBound,
    // strictly greater than the bound), proving the cap never trims the survivor.
    expect(survivorUpdate?.updates.constitution?.why_this_relation_exists).toEqual(survivorWhy);
    expect(survivorUpdate?.updates.constitution?.why_this_relation_exists?.length).toBe(overBound);
    expect(overBound).toBeGreaterThan(MERGE_WHY_MAX_ENTRIES);
    expect(survivorUpdate?.updates.legitimacy?.evidence_basis).toEqual(survivorEvidence);
  });
});
