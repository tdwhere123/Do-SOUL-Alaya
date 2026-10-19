import { afterEach, expect, it, vi } from "vitest";
import { SemanticChainPlanSchema, SEMANTIC_CHAIN_PLAN_CONTRACT } from "../../../runs/recall-measurement/contract.js";

afterEach(() => vi.unstubAllGlobals());

const digest = "a".repeat(64);
const currentPlan = {
  contract: SEMANTIC_CHAIN_PLAN_CONTRACT, input_identity: digest, correspondence_workset: null, queries: [],
  config: {
    snapshot_path: "/tmp/semantic-chain-snapshot", snapshot_sha256: digest,
    implementation_revision: "a".repeat(40), interpretation_clock: "2026-09-18T00:00:00.000Z",
    workspace_id: "workspace", run_id: "run",
    query_workset: {
      contract: "source-semantic-proposal-workset-v3", kind: "query", model: "fixture-model",
      provider_url: "http://127.0.0.1:9", request_profile: "fixture-profile",
      items: [{ original_query: "Which source mentions tungsten?" }]
    },
    query_cache_root: "/tmp/query-cache", correspondence_cache_root: "/tmp/correspondence-cache",
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0,
    access_policy: "query-conditioned-v1",
    budget: { schema_version: 1, work_units: 1000, memory_bytes: 64_000, page_budget: 1,
      finalization_reserve: 0, min_envelope: 0 },
    authorized_scopes: { mode: "named", scopes: ["project"] },
    output_byte_limit: 1024
  }
};

it("admits the retained native plan contract and rejects a version-only v6 relabel without transport", () => {
  expect(SEMANTIC_CHAIN_PLAN_CONTRACT).toBe("source-semantic-chain-plan-v7");
  const fetch = vi.fn(() => { throw new Error("provider transport forbidden"); });
  vi.stubGlobal("fetch", fetch);
  const current = SemanticChainPlanSchema.safeParse(currentPlan);
  expect(current.success, current.success ? "" : JSON.stringify(current.error.issues)).toBe(true);
  const historic = SemanticChainPlanSchema.safeParse({ ...currentPlan, contract: "source-semantic-chain-plan-v6" });
  expect(historic.success).toBe(false);
  expect(JSON.stringify(historic.success ? [] : historic.error.issues)).toMatch(/source-semantic-chain-plan-v7/u);
  expect(fetch).not.toHaveBeenCalled();
});
