import { describe, expect, it } from "vitest";
import type { RecallPolicy, SoulMemorySearchRequest } from "@do-soul/alaya-protocol";
import { buildBenchDiagnosticRecallPolicy } from "../../../harness/daemon/runtime/daemon-recall-result.js";
import { buildRecallPolicy as buildDaemonMemorySearchRecallPolicy } from "../../../../../core-daemon/src/mcp-memory/recall-usage-recall-support.js";
import { buildEffectiveRecallConfigIdentity } from "../../../longmemeval/provenance/effective-recall-config.js";
import { canonicalProductRecallConfig } from "../../../longmemeval/promotion/verifiers/product-policy-verifier.js";

describe("product memory-search recall policy parity", () => {
  it("keeps daemon MCP and benchmark product-default policies identical", () => {
    const request: SoulMemorySearchRequest = {
      query: "deployment rules",
      max_results: 10,
      scope_class: null,
      dimension: null,
      domain_tags: null
    };
    const daemon = buildDaemonMemorySearchRecallPolicy(
      request,
      "surface-product",
      "policy-product"
    );
    const bench = buildBenchDiagnosticRecallPolicy("surface-product", 10, true);

    expect(normalizePolicy(bench)).toEqual(normalizePolicy(daemon));
  });

  it("keeps a generic conflict-awareness override outside product-default identity", () => {
    const genericOverride = buildBenchDiagnosticRecallPolicy("surface-product", 10, false);

    expect(genericOverride.fine_assessment.conflict_awareness).toBe(false);
    expect(canonicalProductRecallConfig()).not.toEqual(
      buildEffectiveRecallConfigIdentity({}, {
        maxResults: 10,
        conflictAwareness: false
      })
    );
  });
});

function normalizePolicy(policy: RecallPolicy) {
  const { runtime_id: _runtimeId, ...stable } = policy;
  return stable;
}
