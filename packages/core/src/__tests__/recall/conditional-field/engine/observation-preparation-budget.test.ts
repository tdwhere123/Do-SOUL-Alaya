import { describe, expect, it } from "vitest";
import { sourceIndexTarget, SourceSemanticNominationOccurrenceSchema, type QueryInterpretation, type QueryProgram } from "@do-soul/alaya-protocol";
import { observeField, type ObserveFieldInput } from "../../../../recall/runtime/conditional-field-observe.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { defaultBudget, defaultView, INTERPRETATION_CLOCK, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";

const digest = `sha256:${"a".repeat(64)}`;
const epsilon: QueryProgram = { schema_version: 1, kind: "epsilon" };
const stored: QueryProgram = { schema_version: 1, kind: "relation", relation_kind: "stored_relation",
  source_variable: "x", target_variable: "y", facet_mode: "same_path", threshold_milligrades: 0,
  guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } };
type Block = Parameters<NonNullable<ObserveFieldInput["on_atomic_work_block"]>>[0];

function query(program = epsilon, sourceOnly = false): QueryInterpretation {
  return { schema_version: 1, query_id: "observation-preparation", snapshot_id: SNAPSHOT_ID,
    status: "resolved", program, view: { ...defaultView(), enumeration_policy: "native_query",
      ...(sourceOnly ? { result_kind_view: "source_only" } : {}) }, holes: [], hypotheses: [] };
}

function run(interpretation: QueryInterpretation, readers: ObserverReaders, work: number,
  resumed?: FieldEngineState, memory = 1_000_000, sourceRevision?: string) {
  const blocks: Block[] = [];
  let progress = 0;
  const state = observeField(interpretation, { workspace_id: "ws", query_text: "needle",
    as_of: INTERPRETATION_CLOCK, authorized_scopes: null, readers,
    budget: defaultBudget({ work_units: work, finalization_reserve: 0, min_envelope: 0, memory_bytes: memory }),
    ...(resumed === undefined ? {} : { resume_field: resumed }),
    ...(sourceRevision === undefined ? {} : { expected_source_revision: sourceRevision }),
    on_atomic_work_block: block => blocks.push(block), on_retained_progress: () => { progress += 1; } });
  expect(state.remaining_exploration).toBeGreaterThanOrEqual(0);
  return { state, blocks, progress };
}

function frozenWitnesses() {
  return [1, 2].map(index => SourceSemanticNominationOccurrenceSchema.parse({
    reference: `reference-${index}`, attempt: index, view: "original",
    source: sourceIndexTarget({ kind: "source_evidence", workspace_id: "ws", root_kind: "source_record",
      root_id: `sha256:${String(index).padStart(64, "0")}`, source_version: "1", content_digest: digest,
      evidence_object_id: null }, `source-${index}`, 16),
    route: { kind: "lexical", native_rank: index, lane: "unicode61", lane_rank: index, bm25: -1 }
  }));
}

describe("observation setup and atomic work admission", () => {
  it("reports the restarted native-witness prefix instead of certifying repeated partial setup", () => {
    const witness = frozenWitnesses();
    const readers: ObserverReaders = { nominateSources: () => ({ result: null, witness,
      navigation_digests: { original: digest }, admitted_roots: witness.map(row => row.source.target) }) };
    const first = run(query(), readers, 6);
    const second = run(query(), readers, 6, first.state);
    const block = second.blocks.find(row => row.phase === "native_source_setup");
    expect(block?.required_exploration_work).toBeGreaterThan(6);
    expect(second.progress).toBe(0);
    expect(second.state.memory_exhausted).toBe(false);
    const larger = run(query(), readers, 1_000, second.state);
    expect(larger.blocks.some(row => row.phase === "native_source_setup")).toBe(false);
  });

  it("keeps native-witness memory refusal separate from a work requirement", () => {
    const witness = frozenWitnesses();
    const result = run(query(), { nominateSources: () => ({ result: null, witness,
      navigation_digests: { original: digest } }) }, 1_000, undefined, 512);
    expect(result.state.memory_exhausted).toBe(true);
    expect(result.blocks.some(row => row.phase === "native_source_setup")).toBe(false);
  });

  it("retains a prior memory refusal when rebuilding native witnesses also lacks work", () => {
    const witness = frozenWitnesses();
    const readers: ObserverReaders = { nominateSources: () => ({ result: null, witness,
      navigation_digests: { original: digest } }) };
    const initial = run(query(), readers, 6);
    const refused = run(query(), readers, 0, initial.state, 1);
    expect(refused.state.memory_exhausted).toBe(true);
    expect(refused.blocks.some(row => row.phase === "native_source_setup")).toBe(true);
  });

  it.each([false, true])("reports binding-only zero/short work through the profile owner with snapshot pin %s", pinned => {
    const interpretation: QueryInterpretation = { ...query(), interpretation_proposal: {
      schema_version: 1, original_query_digest: digestOriginalQuery("needle"), producer_id: "alaya.query.proposal.core.v1",
      stored_cosine_admission: { registry_version: "stored.cosine.admission.v1", join: "any", obligations: [{
        obligation_id: "profile", producer_id: "stored.cosine.pair.v1", provider_kind: "openai", model_id: "fixture",
        schema_version: 1, dimensions: 4, domain: "cosine.unit.v1", normalization: "l2.dot.v1", raw_threshold: 0,
        transfer_id: "policy.cosine.linear.milligrade.v1", transfer_version: "1", policy_defined: true
      }] }
    } };
    let enumerated = 0;
    const readers: ObserverReaders = {
      ...(pinned ? { snapshotPin: () => ({ source_revision: "fixed" }) } : {}),
      lexical: () => ({ ids: [], rowsRead: 0, nativeVisits: 0, nativeBytes: 0, bytesRead: 0, truncated: false }),
      embeddingIds: input => { enumerated += 1; return { objectIds: [], rowVisits: 0, metadataUtf8Bytes: 0,
        truncated: true, committedThrough: input.afterObjectId }; },
      measureStoredPair: () => ({ object: null, query: null, objectStatus: "unavailable", queryStatus: "unavailable", rowVisits: 0, bytesRead: 0 }),
      source: () => ({ row: null, rowsRead: 4, bytesRead: 0, unavailable: true })
    };
    const initial = run(interpretation, readers, 1_000, undefined, 1_000_000, pinned ? "fixed" : undefined);
    expect(initial.state.residuals.find(region => region.kind === "seed")?.status).toBe("exhausted");
    const before = enumerated;
    for (const allowance of [0, 2]) {
      const refused = run(interpretation, readers, allowance, initial.state, 1_000_000, pinned ? "fixed" : undefined);
      expect(enumerated).toBe(before);
      expect(refused.blocks).toContainEqual(expect.objectContaining({ phase: "measurement",
        required_exploration_work: pinned ? 17 : 14 }));
    }
  });

  it("includes the unretained relation-kind prefix in the next observation requirement", () => {
    let reads = 0;
    const readers: ObserverReaders = {
      relationKinds: input => Array.from({ length: input.limit ?? 32 }, (_, index) => `kind-${index}`),
      lexical: () => { reads += 1; return { ids: [], nativeVisits: 0, nativeBytes: 0,
        rowsRead: 0, bytesRead: 0, truncated: true }; }
    };
    const initial = run(query(stored), readers, 1_000);
    reads = 0;
    const limited = run(query(stored), readers, 16, initial.state);
    expect(reads).toBe(0);
    expect(limited.blocks.some(row => row.required_exploration_work > 16)).toBe(true);
    expect(limited.progress).toBe(0);
    run(query(stored), readers, 64, limited.state);
    expect(reads).toBeGreaterThan(0);
  });

  it("does not count source lane rotation without a source, memory or hint advance", () => {
    const readers: ObserverReaders = { sourceRoots: input => ({ rows: [], rowsRead: 0,
      nativeVisits: 1, nativeBytes: 0, bytesRead: 0, truncated: true, resourceLimited: true,
      committedThrough: input.afterCursor }) };
    const first = run(query(epsilon, true), readers, 10);
    const second = run(query(epsilon, true), readers, 10, first.state);
    expect(second.state.resume_cursors.seed).not.toBe(first.state.resume_cursors.seed);
    expect(second.progress).toBe(0);
    expect(second.state.observations.length).toBe(0);
  });
});
