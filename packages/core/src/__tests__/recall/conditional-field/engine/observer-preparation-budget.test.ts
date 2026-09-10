import { describe, expect, it, vi } from "vitest";
import type { QueryInterpretation } from "@do-soul/alaya-protocol";
import { createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { createAdjacencyEffectCursor, seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

describe("observer preparation under a small continuation allowance", () => {
  it.each([2, 13])("does not rescan every retained product under a %i-unit continuation", (work) => {
    const interpretation: QueryInterpretation = { schema_version: 1, query_id: "bounded-observer-preparation",
      snapshot_id: SNAPSHOT_ID, status: "resolved", holes: [], hypotheses: [], view: defaultView(),
      program: { schema_version: 1, kind: "relation", relation_kind: "p", source_variable: "x", target_variable: "y",
        guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" },
        facet_mode: "same_path", threshold_milligrades: 0 } };
    const programState = seedProgramStates(interpretation.program)[0]!;
    const field = createConditionalField({ interpretation,
      budget: defaultBudget({ work_units: 100_000, memory_bytes: 10_000_000 }),
      seeds: Array.from({ length: 1000 }, (_, index) => ({ schema_version: 1 as const,
        state: productKey(`seed-${index}`, "h0", "unbound", programState), milligrades: 1000 })) });
    expect(field.memory_exhausted).toBe(false);
    expect(field.seen_identities.length).toBe(1000);
    const visits = vi.spyOn(field.seen_identities, "at");
    expect(field.seeds).toBe(field.retained_index!.rows.seeds);
    const retainedSeedVisits = vi.spyOn(field.seeds, "at");
    let nativeCalls = 0;
    const result = observeField(interpretation, { workspace_id: "workspace-1", query_text: "seed",
      as_of: "2026-09-10T00:00:00.000Z", resume_field: field,
      budget: defaultBudget({ work_units: work, finalization_reserve: 0, min_envelope: 0, memory_bytes: 10_000_000 }),
      readers: { lexical: () => {
        nativeCalls += 1;
        return { ids: [], rowsRead: 0, bytesRead: 0, nativeVisits: 0, nativeBytes: 0, truncated: false };
      } } });
    expect(result.remaining_exploration).toBeGreaterThanOrEqual(0);
    if (work === 2) {
      expect(nativeCalls).toBe(0);
      expect(result.last_observer_status).toBe("interrupted");
    } else expect(nativeCalls).toBeGreaterThan(0);
    expect(visits.mock.calls.length).toBeLessThanOrEqual(work);
    expect(retainedSeedVisits.mock.calls.length).toBeLessThanOrEqual(work);
  });

  it("admits a real one-row native delta without copying old rows or changing a pending cursor's version", () => {
    const interpretation: QueryInterpretation = { schema_version: 1, query_id: "retained-native-delta", snapshot_id: SNAPSHOT_ID,
      status: "resolved", holes: [], hypotheses: [], view: defaultView(),
      program: { schema_version: 1, kind: "relation", relation_kind: "p", source_variable: "x", target_variable: "y",
        guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" }, facet_mode: "same_path", threshold_milligrades: 0 } };
    const programState = seedProgramStates(interpretation.program)[0]!;
    const field = createConditionalField({ interpretation, budget: defaultBudget({ work_units: 100000, memory_bytes: 10000000 }),
      seeds: Array.from({ length: 1000 }, (_, index) => ({ schema_version: 1, state: productKey(`old-${index}`, "h0", "unbound", programState), milligrades: 1000 })) });
    const priorSeeds = field.seeds;
    const priorIdentities = field.seen_identities;
    const seedVisits = vi.spyOn(priorSeeds, "at");
    const identityVisits = vi.spyOn(priorIdentities, "at");
    const edge = { assertionId: "future-edge", sourceObjectId: "fresh", targetObjectId: "target", predicate: "p",
      source_revision: "rev", validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" } };
    const options = { interpretation, asOf: "2026-09-10T00:00:00.000Z", liveStates: priorIdentities, overlay: {},
      sourceFacts: new Map(["fresh", "target"].map((object_id) => [object_id, { object_id, source_revision: "rev" }])) };
    const pending = createAdjacencyEffectCursor([edge], options);
    let native = 0;
    const next = observeField(interpretation, { workspace_id: "workspace-1", query_text: "fresh", as_of: options.asOf, resume_field: field,
      budget: defaultBudget({ work_units: 25, finalization_reserve: 0, min_envelope: 0, memory_bytes: 10000000 }), readers: {
        lexical: () => { native += 1; return { ids: ["fresh"], rowsRead: 1, bytesRead: 5, nativeVisits: 1, nativeBytes: 5, truncated: false }; },
        source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", content: "fresh", lifecycle_state: "active", scope_class: "project" },
          rowsRead: 1, bytesRead: 5, unavailable: false })
      } });
    expect(native).toBeGreaterThan(0);
    expect(next.seeds.length).toBe(1001);
    expect(next.seeds.some((seed) => seed.state.target.kind === "memory_entry" && seed.state.target.object_id === "fresh")).toBe(true);
    expect(seedVisits.mock.calls.length).toBeLessThanOrEqual(25);
    expect(identityVisits.mock.calls.length).toBeLessThanOrEqual(25);
    expect(priorSeeds.length).toBe(1000);
    expect(priorIdentities.length).toBe(1000);
    expect(pending.advance(0, 10000, 10000000).effects).toEqual([]);
    const current = createAdjacencyEffectCursor([edge], { ...options, liveStates: next.seen_identities });
    expect(current.advance(0, 10000, 10000000).effects.some((effect) => effect.transition !== undefined)).toBe(true);
  });
});
