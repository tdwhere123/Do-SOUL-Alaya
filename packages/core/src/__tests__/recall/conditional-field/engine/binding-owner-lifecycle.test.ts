import { describe, expect, it } from "vitest";
import type { ObserverPage, QueryInterpretation } from "@do-soul/alaya-protocol";
import { BindingContextStore, BindingContextResourceError, BindingContextUnavailableError,
  encodeBindingContext, parseBindingContext } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { createConditionalField, applyObserverPage } from "../../../../recall/conditional-field/engine/field-engine.js";
import { adjacencyEffectsForRows, createAdjacencyEffectCursor, seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition.js";
import { claimObligationAccepts } from "../../../../recall/conditional-field/index/claim-obligation.js";
import { retainedFieldLevels, snapshotRestoredEngineWork } from "../../../../recall/runtime/request-cost-engine-snapshot.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { PathEffectCursor, type PathComputation } from "../../../../recall/conditional-field/engine/path-effect-cursor.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const query: QueryInterpretation = { schema_version: 1, query_id: "binding-owner", snapshot_id: SNAPSHOT_ID,
  status: "resolved", hypotheses: [], holes: [], view: defaultView(),
  program: { schema_version: 1, kind: "relation", relation_kind: "p", source_variable: "x", target_variable: "y",
    facet_mode: "same_path", threshold_milligrades: 0,
    guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } } };
const page: ObserverPage = { schema_version: 1, query_id: query.query_id, snapshot_id: SNAPSHOT_ID,
  cursor: { schema_version: 1, cursor_id: "seed", query_id: query.query_id, snapshot_id: SNAPSHOT_ID,
    region_id: "seed", position: null, committed_through: null },
  observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
const env = (value: string) => new Map([["x", "a"], ["long-variable", value.repeat(400)]]);
const budget = defaultBudget({ work_units: 100_000, memory_bytes: 1_000_000 });

describe("execution-owned binding recovery", () => {
  it("rebuilds a failed generator without dropping committed or prepared effects", () => {
    const owner = new BindingContextStore(20_000);
    const initial = createConditionalField({ interpretation: query, budget, binding_contexts: owner });
    const effect = (id: string, binding = "unbound") => ({ observation_id: id, admitted_seed: true as const,
      seed: { schema_version: 1 as const, state: productKey(id, "h0", binding), milligrades: 1000 } });
    let builds = 0;
    const cursor = new PathEffectCursor(function* (): PathComputation<void> {
      builds += 1;
      yield { kind: "work", retained_bytes: 100 };
      yield { kind: "work", retained_bytes: 300, retention: "effect_payload" };
      yield { kind: "effect", effect: effect("committed") };
      yield { kind: "work", retained_bytes: 300, retention: "effect_payload" };
      yield { kind: "effect", effect: effect("prepared") };
      const binding = encodeBindingContext(env("large"), owner);
      yield { kind: "work", retained_bytes: 300, retention: "effect_payload" };
      yield { kind: "effect", effect: effect("after-binding", binding) };
    }, 100, owner);
    const first = cursor.advance(0, 4, 3_000);
    expect(first.effects.map((effect) => effect.observation_id)).toEqual(["committed"]);
    const committed = applyObserverPage(initial, { page, effects: first.effects });
    expect(committed.seeds).toHaveLength(1);
    const prior = owner.snapshot();
    const failed = cursor.advance(first.offset, 20, 3_000);
    expect(failed.status).toBe("memory_exhausted");
    expect(failed.offset).toBe(first.offset);
    expect(failed.effects).toEqual([]);
    const restarted = cursor.advance(first.offset, 0, 3_000);
    expect(restarted.retained_bytes).toBe(100 + 2 * (64 + 300));
    expect(failed.retained_bytes - restarted.retained_bytes).toBe(100);
    const failedAgain = cursor.advance(first.offset, 20, 3_000);
    expect(failedAgain.status).toBe("memory_exhausted");
    expect(failedAgain.retained_bytes).toBe(failed.retained_bytes);
    expect(failedAgain.completed_work).toBeGreaterThan(failed.completed_work);
    const recovered = cursor.advance(first.offset, 20, 20_000);
    expect(recovered.status).toBe("complete");
    expect(recovered.effects.map((effect) => effect.observation_id)).toEqual(["prepared", "after-binding"]);
    expect(builds).toBe(3);
    expect(recovered.completed_work - failedAgain.completed_work).toBe(8);
    expect(recovered.retained_bytes).toBe(100 + 100 + 3 * (64 + 300) + owner.bytes);
    expect(prior.bytes).toBe(0);
    const applied = applyObserverPage(committed, { page, effects: recovered.effects, binding_contexts: owner });
    expect(applied.retention_rejected).toBeUndefined();
    expect(applied.seeds).toHaveLength(3);
    expect(committed.seeds).toHaveLength(1);
    expect(committed.binding_contexts!.bytes).toBe(0);
    expect(cursor.advance(0, 20, 20_000).effects.map((effect) => effect.observation_id))
      .toEqual(["committed", "prepared", "after-binding"]);
  });

  it("retains native compiled payloads across rebuild and one-work resumes", () => {
    const requestBudget = { ...budget, finalization_reserve: 100, min_envelope: 10 };
    const interpretation = compileConditionalFieldQuery({ source: "typed", program: query.program, budget: requestBudget,
      snapshot_id: SNAPSHOT_ID, authorized_scopes: null, interpretation_clock: "2026-09-10T00:00:00Z",
      view: { schema_version: 1, requested_roles: ["requested", "associated"], result_kind_view: "memory_only" } });
    const rows = Array.from({ length: 16 }, (_, i) => ({ assertionId: "e".repeat(250) + String(i).padStart(2, "0"),
      sourceObjectId: "a", targetObjectId: i === 15 ? "B".repeat(256) : `short-${i}`, predicate: "p",
      validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00Z" } }));
    const owner = new BindingContextStore(53_000);
    const cursor = createAdjacencyEffectCursor(rows, { interpretation, asOf: "2026-09-10T00:00:00Z",
      liveStates: seedProgramStates(query.program).map((state) => productKey("a", "h0", "x=a", state)),
      sourceFacts: new Map(["a", ...rows.map((row) => row.targetObjectId)].map((object_id) => [object_id, { object_id, source_revision: "rev" }])),
      overlay: { p: { applicable: true, milligrades: 1000 } }, bindingContexts: owner }, 53_000)!;
    const failed = cursor.advance(0, 100_000, 53_000);
    expect(failed.status).toBe("memory_exhausted");
    expect(failed.effects).toEqual([]);
    const restarted = cursor.advance(0, 0, 53_000);
    const cached = cursor.advance(0, 15, 53_000);
    expect(cached.effects).toHaveLength(15);
    const payloadBytes = cached.effects.reduce((sum, effect) => sum + 512
      + Buffer.byteLength(JSON.stringify({ transition: effect.transition, derivation: effect.derivation, facet: effect.facet }), "utf8"), 0);
    expect(restarted.retained_bytes).toBeGreaterThanOrEqual(payloadBytes + 15 * 64);
    expect(restarted.retained_bytes).toBeLessThan(failed.retained_bytes);
    let offset = 0, completedWork = cached.completed_work;
    const effects = [];
    let complete = false;
    for (let i = 0; i < 2_000 && !complete; i++) {
      const next = cursor.advance(offset, 1, 1_000_000);
      expect(next.work).toBeLessThanOrEqual(1);
      expect(next.completed_work - completedWork).toBeLessThanOrEqual(next.work);
      completedWork = next.completed_work;
      offset = next.offset;
      effects.push(...next.effects);
      complete = next.status === "complete";
    }
    expect(complete).toBe(true);
    expect(effects).toHaveLength(16);
    expect(new Set(effects.map((effect) => effect.observation_id)).size).toBe(16);
    cached.effects.forEach((effect, i) => expect(effects[i]).toBe(effect));
  });

  it("recovers a typed native relation after raising the binding memory budget", () => {
    const requestBudget = { ...budget, finalization_reserve: 100, min_envelope: 10 };
    const interpretation = compileConditionalFieldQuery({ source: "typed", program: query.program, budget: requestBudget,
      snapshot_id: SNAPSHOT_ID, authorized_scopes: null, interpretation_clock: "2026-09-10T00:00:00Z",
      view: { schema_version: 1, requested_roles: ["requested", "associated"], result_kind_view: "memory_only" } });
    const target = "B".repeat(256);
    const readers: ObserverReaders = {
      lexical: () => ({ ids: ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
      source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 1, unavailable: false }),
      relation: ({ subject, predicate, afterAssertionId }) => {
        const observations = subject === "a" && predicate === "p" && afterAssertionId === null
          ? [{ assertionId: "edge", sourceObjectId: "a", targetObjectId: target, predicate: "p",
            validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00Z" } }] : [];
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length, rowsRead: observations.length,
          bytesRead: observations.length, truncated: false, committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const input = { workspace_id: "ws", query_text: "a", authorized_scopes: null, as_of: "2026-09-10T00:00:00Z",
      readers, budget: requestBudget };
    const failed = observeField(interpretation, { ...input, budget: { ...requestBudget, memory_bytes: 17_900 } });
    expect(failed.memory_exhausted).toBe(true);
    expect(failed.transitions).toHaveLength(0);
    const priorBytes = failed.binding_contexts!.bytes;
    const recovered = observeField(interpretation, { ...input, resume_field: failed });
    const fresh = observeField(interpretation, input);
    expect(recovered.transitions).toEqual(fresh.transitions);
    expect(recovered.transitions).toHaveLength(1);
    expect(recovered.memory_exhausted).toBe(false);
    expect(failed.binding_contexts!.bytes).toBe(priorBytes);
    expect(retainedFieldLevels(recovered, requestBudget.memory_bytes).retained_bytes_current)
      .toBeGreaterThanOrEqual(recovered.binding_contexts!.bytes);
  });
  it("meters long native seeds and resumed path computation in the field owner", () => {
    const interpretation: QueryInterpretation = { ...query, hypotheses: [{ schema_version: 1, hypothesis_id: "long",
      bindings: [{ schema_version: 1, variable: "payload", value: "x".repeat(4_000) }] }] };
    const readers: ObserverReaders = {
      lexical: () => ({ ids: ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
      source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 1, unavailable: false }),
      relation: ({ subject, predicate, afterAssertionId }) => {
        const observations = subject === "a" && predicate === "p" && afterAssertionId === null
          ? [{ assertionId: "edge", sourceObjectId: "a", targetObjectId: "b", predicate: "p",
            validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00Z" } }] : [];
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length, rowsRead: observations.length,
          bytesRead: observations.length, truncated: false, committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const input = { workspace_id: "ws", query_text: "a", authorized_scopes: null, as_of: "2026-09-10T00:00:00Z", readers,
      budget: { ...budget, work_units: 100, finalization_reserve: 20 } };
    let field = observeField(interpretation, input);
    for (let i = 0; i < 100 && field.transitions.length === 0; i++) {
      const prior = field.binding_contexts;
      const bytes = prior?.bytes;
      field = observeField(interpretation, { ...input, resume_field: field });
      expect(prior?.bytes).toBe(bytes);
    }
    expect(field.transitions.length).toBeGreaterThan(0);
    expect(field.binding_contexts!.bytes).toBeGreaterThan(8_000);
    expect(retainedFieldLevels(field, budget.memory_bytes).retained_bytes_current).toBeGreaterThanOrEqual(field.binding_contexts!.bytes);
    for (const edge of field.transitions) expect(parseBindingContext(edge.to.binding_context, field.binding_contexts).get("payload")).toBe("x".repeat(4_000));
  });
  it("charges standalone create and apply, with immutable retained owners", () => {
    const owner = new BindingContextStore(budget.memory_bytes);
    const binding = encodeBindingContext(env("original"), owner);
    const seed = { schema_version: 1 as const, state: productKey("a", "h0", binding, "q0"), milligrades: 1000 };
    const field = createConditionalField({ interpretation: query, budget, seeds: [seed], binding_contexts: owner });
    const baseline = createConditionalField({ interpretation: query, budget,
      seeds: [{ ...seed, state: { ...seed.state, binding_context: "unbound" } }] });
    expect(baseline.remaining_memory_bytes - field.remaining_memory_bytes).toBeGreaterThanOrEqual(owner.bytes);
    expect(field.binding_context_bytes).toBe(owner.bytes);
    expect(retainedFieldLevels(field, budget.memory_bytes).retained_bytes_current).toBeGreaterThanOrEqual(owner.bytes);
    expect(snapshotRestoredEngineWork(field, budget.memory_bytes).remaining_memory_bytes).toBe(budget.memory_bytes - owner.bytes);
    expect(() => encodeBindingContext(env("mutate"), field.binding_contexts)).toThrow(BindingContextResourceError);
    const prepared = field.binding_contexts!.fork(field.remaining_memory_bytes);
    const added = encodeBindingContext(env("prepared"), prepared);
    const updated = applyObserverPage(field, { page, binding_contexts: prepared, effects: [{
      observation_id: "new-seed", admitted_seed: true, seed: { ...seed,
        state: { ...seed.state, hypothesis_id: "new", binding_context: added } }
    }] });
    expect(updated.retention_rejected).toBeUndefined();
    expect(updated.binding_context_bytes).toBe(prepared.bytes);
    expect(field.remaining_memory_bytes - updated.remaining_memory_bytes).toBeGreaterThanOrEqual(prepared.bytes - owner.bytes);
    expect(() => parseBindingContext(added, field.binding_contexts)).toThrow(BindingContextUnavailableError);
    expect(parseBindingContext(added, updated.binding_contexts)).toEqual(env("prepared"));
    expect(() => createConditionalField({ interpretation: query, budget, seeds: [seed] })).toThrow(BindingContextUnavailableError);
  });

  it("retains long environments through actual relation admission and claim projection", () => {
    const owner = new BindingContextStore(budget.memory_bytes);
    const context = encodeBindingContext(env("original"), owner);
    const from = productKey("a", "h0", context, seedProgramStates(query.program)[0]);
    const effects = adjacencyEffectsForRows([{ assertionId: "edge", sourceObjectId: "a", targetObjectId: "b",
      predicate: "p", validity: { kind: "open", valid_from: "2026-01-01T00:00:00Z" } }], {
      interpretation: query, asOf: "2026-09-10T00:00:00Z", liveStates: [from], bindingContexts: owner,
      overlay: { p: { applicable: true, milligrades: 1000 } },
      sourceFacts: new Map(["a", "b"].map((object_id) => [object_id, { object_id, source_revision: "rev" }]))
    });
    const target = effects.find((effect) => effect.transition !== undefined)?.transition?.to;
    expect(target).toBeDefined();
    expect(parseBindingContext(target!.binding_context, owner).get("y")).toBe("b");
    const value = { state: target!, lower: 1000, upper: 1000 } as Parameters<typeof claimObligationAccepts>[0];
    const view = { ...defaultView(), claim_demands: [{ variable: "y", required_claim: "supported" as const }] };
    expect(claimObligationAccepts(value, view, "supported", owner)).toBe(true);
    expect(claimObligationAccepts(value, view, "unknown", owner)).toBe(false);
    expect(() => claimObligationAccepts(value, view, "supported")).toThrow(BindingContextUnavailableError);
  });

  it("rejects over-budget preparation without publishing its recovery entries", () => {
    const state = createConditionalField({ interpretation: query, budget });
    const prepared = state.binding_contexts!.fork(100_000);
    const context = encodeBindingContext(env("large"), prepared);
    const rejected = applyObserverPage({ ...state, remaining_memory_bytes: 10 }, { page, binding_contexts: prepared,
      effects: [{ observation_id: "too-large", admitted_seed: true,
        seed: { schema_version: 1, state: productKey("a", "h0", context), milligrades: 1000 } }] });
    expect(rejected.retention_rejected).toBe("memory");
    expect(rejected.binding_contexts?.bytes).toBe(0);
    expect(() => parseBindingContext(context, rejected.binding_contexts)).toThrow(BindingContextUnavailableError);
  });
});
