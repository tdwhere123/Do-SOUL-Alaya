import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { QueryInterpretation } from "@do-soul/alaya-protocol";
import * as automata from "../../../../recall/conditional-field/engine/program-automaton.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { RequestCostLedger } from "../../../../recall/runtime/request-cost-ledger.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

it("reuses the charged program automaton for two measured seed rows", () => {
  const content = "retained source";
  const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const interpretation: QueryInterpretation = { schema_version: 1, query_id: "measured-seed-reuse",
    snapshot_id: SNAPSHOT_ID, status: "resolved", holes: [], hypotheses: [], view: defaultView(),
    program: { schema_version: 1, kind: "repeat", count: 8, local_variables: ["s", "t"],
      body: { schema_version: 1, kind: "relation", relation_kind: "p", source_variable: "s", target_variable: "t",
        facet_mode: "same_path", threshold_milligrades: 0,
        guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" } } },
    interpretation_proposal: { schema_version: 1, original_query_digest: `sha256:${"a".repeat(64)}`,
      producer_id: "alaya.query.proposal.core.v1", stored_cosine_admission: {
        registry_version: "stored.cosine.admission.v1", join: "any", obligations: [{
          obligation_id: "stored-fixture", producer_id: "stored.cosine.pair.v1", model_id: "stored-fixture",
          provider_kind: "openai", schema_version: 1, dimensions: 2, domain: "cosine.unit.v1",
          normalization: "l2.dot.v1", raw_threshold: 0.5, transfer_id: "policy.cosine.linear.milligrade.v1",
          transfer_version: "1", policy_defined: true }] } } };
  const vector = (objectId: string) => ({ object_id: objectId, model_id: "stored-fixture", provider_kind: "openai",
    schema_version: 1, dimensions: 2, content_hash: contentHash, embedding: new Float32Array([1, 0]) });
  const compile = vi.spyOn(automata, "compileProgramAutomaton");
  const cost = new RequestCostLedger();
  try {
    const state = observeField(interpretation, { workspace_id: "ws", query_text: "q", as_of: "2026-09-10T00:00:00.000Z",
      authorized_scopes: null, budget: defaultBudget({ work_units: 10000, memory_bytes: 1000000 }), cost,
      readers: {
        lexical: () => ({ ids: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0, truncated: false }),
        source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", content,
          lifecycle_state: "active", scope_class: "project" }, rowsRead: 1, bytesRead: content.length, unavailable: false }),
        embeddingIds: () => ({ objectIds: ["emb-1", "emb-2"], rowVisits: 2, metadataUtf8Bytes: 16,
          truncated: false, committedThrough: "emb-2" }),
        measureStoredPair: ({ objectId }) => ({ object: vector(objectId), query: vector("query"),
          objectStatus: "ready", queryStatus: "ready", rowVisits: 2, bytesRead: 16 }),
        relation: ({ afterAssertionId }) => ({ observations: [], nativeVisits: 0, nativeBytes: 0,
          rowsRead: 0, bytesRead: 0, truncated: false, committedThrough: afterAssertionId })
      } });
    expect([...state.measurements].filter((row) => row.raw.status === "measured")).toHaveLength(2);
    expect(state.seeds).toHaveLength(2);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(cost.snapshot().phases.observe.joins).toBeGreaterThanOrEqual(
      automata.programAutomatonCost(interpretation.program).work_units);
  } finally { compile.mockRestore(); }
});
