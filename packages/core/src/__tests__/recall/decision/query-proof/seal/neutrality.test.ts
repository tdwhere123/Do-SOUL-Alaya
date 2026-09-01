import { describe, expect, it } from "vitest";
import { buildRecallCandidateDedupeKey } from
  "../../../../../recall/runtime/recall-service-helpers.js";
import { captureShadowIntegration } from
  "../../../../../recall/integration/shadow/integrate.js";
import {
  deliverCanonicalFineAssessment,
  toShadowInput
} from "../../../../../recall/delivery/canonical-delivery.js";
import { digestDecisionContract } from
  "../../../../../recall/decision/query-proof/seal/contract.js";
import { createQueryCompiledWalkTransfer } from
  "../../../../../recall/decision/query-proof/gamma/walk-binding.js";
import {
  emptyWalkUtility,
  type QueryProofDecideWorldV1
} from "../../../../../recall/decision/query-proof/seal/decide.js";
import { fieldCandidates } from "../../../delivery/canonical-delivery-fixtures.js";
import { params } from "../../../integration/shadow/live-receipt-fixtures.js";
import {
  binding,
  candidate,
  compileGamma,
  compileInputFor,
  scalarQuery
} from "../gamma/gamma-fixture.js";

function previewWorld(
  keys: readonly string[],
  cycle = false
): QueryProofDecideWorldV1 {
  const evidence = keys.map((key) => candidate(key, { bindings: [binding(key)] }));
  const compileInput = compileInputFor(scalarQuery(), evidence);
  const compiled = compileGamma(scalarQuery(), evidence);
  return Object.freeze({
    compiled,
    compile_input: compileInput,
    candidates: keys.map((key) => Object.freeze({
      candidate_key: key,
      object_key: key,
      token_cost: 1,
      dimension: "mem",
      h_eligible: true,
      utility: emptyWalkUtility(key, key),
      static_frontier_index: null
    })),
    psi_edges: cycle && keys.length >= 2
      ? Object.freeze([[keys[0]!, keys[1]!], [keys[1]!, keys[0]!]] as const)
      : Object.freeze([]),
    token_budget: 10,
    per_dimension_limits: null,
    unresolved_tradeoff_pairs: Object.freeze([]),
    answer_bindings: keys.map((key) => Object.freeze({
      candidate_key: key,
      binding_id: `bind:${key}`,
      value: key
    }))
  });
}

describe("query-proof preview neutrality", () => {
  it("preview-on/off leaves selected keys and prefix order unchanged", () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const keys = candidates.map(buildRecallCandidateDedupeKey);
    const world = previewWorld(keys);
    const transfer = createQueryCompiledWalkTransfer(world.compiled);
    const expectedDigest = digestDecisionContract(world.compiled, transfer.contract_digest);
    const base = params(candidates);
    const offCounts = { estimate: 0, cache: 0 };
    const onCounts = { estimate: 0, cache: 0 };
    const frozenSupplementary = Object.freeze({ ...base.supplementaryData });
    const offSupplementary = new Proxy(frozenSupplementary, {
      get(target, property, receiver) {
        offCounts.cache += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    const onSupplementary = new Proxy(frozenSupplementary, {
      get(target, property, receiver) {
        onCounts.cache += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    const off = captureShadowIntegration({
      ...toShadowInput({
        ...base,
        supplementaryData: offSupplementary,
        tokenEstimator: { estimate: () => { offCounts.estimate += 1; return 4; } }
      })
    });
    const on = captureShadowIntegration({
      ...toShadowInput({
        ...base,
        supplementaryData: onSupplementary,
        tokenEstimator: { estimate: () => { onCounts.estimate += 1; return 4; } },
        query_proof_preview: { world }
      })
    });
    expect(off.kind).toBe("captured");
    expect(on.kind).toBe("captured");
    if (off.kind !== "captured" || on.kind !== "captured") throw new Error("expected");
    expect(on.S_infty).toEqual(off.S_infty);
    expect(on.prefix_proposal).toEqual(off.prefix_proposal);
    expect(on.eligible_keys).toEqual(off.eligible_keys);
    expect("query_proof_preview" in off).toBe(false);
    expect(on.query_proof_preview?.status).toBe("captured");
    expect(on.query_proof_preview?.contract_digest).toBe(expectedDigest);
    expect(on.query_proof_preview?.prefix).toEqual(on.query_proof_preview?.candidate_prefix);
    expect(on.query_proof_preview?.pick_reasons.length).toBeGreaterThan(0);
    expect(on.query_proof_preview?.semantic_feasibility.length).toBe(keys.length);
    expect(onCounts.estimate).toBe(offCounts.estimate);
    expect(onCounts.cache).toBe(offCounts.cache);
  });

  it("keeps live capture when the opt-in Decide_Q preview sidecar fails", () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const keys = candidates.map(buildRecallCandidateDedupeKey);
    const captured = captureShadowIntegration({
      ...toShadowInput(params(candidates)),
      query_proof_preview: { world: previewWorld(keys, true) }
    });
    expect(captured.kind).toBe("captured");
    if (captured.kind !== "captured") throw new Error("expected");
    expect(captured.query_proof_preview?.status).toBe("failed");
    expect(captured.query_proof_preview?.semantic_feasibility).toEqual([]);
    expect(captured.S_infty.length).toBeGreaterThan(0);
  });

  it("keeps live capture when the preview world is malformed", () => {
    const candidates = fieldCandidates(["cand-a"]);
    const captured = captureShadowIntegration({
      ...toShadowInput(params(candidates)),
      query_proof_preview: { world: null as never }
    });
    expect(captured.kind).toBe("captured");
    if (captured.kind !== "captured") throw new Error("expected");
    expect(captured.query_proof_preview?.status).toBe("failed");
    expect(captured.query_proof_preview?.contract_digest).toBe("sha256:preview_unavailable");
    expect(captured.query_proof_preview?.semantic_feasibility).toEqual([]);
    expect(captured.S_infty.length).toBeGreaterThan(0);
  });

  it("does not surface forged compiled feasibility from a failed preview world", () => {
    const candidates = fieldCandidates(["cand-a"]);
    const captured = captureShadowIntegration({
      ...toShadowInput(params(candidates)),
      query_proof_preview: {
        world: {
          compiled: {
            compile_status: "compiled",
            semantic_feasibility: Object.freeze([{
              candidate_key: "forged",
              semantic: "feasible"
            }]),
            resource_policy: Object.freeze({
              schema_version: 1,
              reject_duplicate_object: true,
              token_budget: null,
              per_dimension_limits: null
            })
          }
        } as never
      }
    });
    expect(captured.kind).toBe("captured");
    if (captured.kind !== "captured") throw new Error("expected");
    expect(captured.query_proof_preview?.status).toBe("failed");
    expect(captured.query_proof_preview?.semantic_feasibility).toEqual([]);
    expect(captured.S_infty.length).toBeGreaterThan(0);
  });

  it("production fine-assessment preview does not change selected keys or public result", () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const keys = candidates.map(buildRecallCandidateDedupeKey);
    const world = previewWorld(keys);
    const offParams = params(candidates);
    const onParams = Object.freeze({
      ...offParams,
      query_proof_preview: Object.freeze({ world })
    });
    const off = deliverCanonicalFineAssessment(offParams);
    const on = deliverCanonicalFineAssessment(onParams);
    expect(on.candidates.map((row) => row.object_id))
      .toEqual(off.candidates.map((row) => row.object_id));
    expect(on.ranking_authority).toBe(off.ranking_authority);
    expect(on.delivery_path).toBe(off.delivery_path);
    expect(toShadowInput(onParams).query_proof_preview?.world).toBe(world);
    expect(toShadowInput(offParams).query_proof_preview).toBeUndefined();
  });
});
