import { describe, expect, it } from "vitest";
import {
  evaluateGatewayEnvelope,
  resolveGatewayMode
} from "../gateway/index.js";
import type { ContextDeliveryRecord, MemorySessionEvent } from "../session/index.js";
import type { ProposalRecord, ProviderSelectionResult } from "../provider/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("Gateway audit and strict envelope helpers", () => {
  it("defaults to audit mode and records bypass without blocking execution", () => {
    const result = evaluateGatewayEnvelope({
      ...gatewayInput(),
      bypass: {
        attempted_operation: "agent.direct_write",
        detected: true,
        reason: "agent attempted direct storage write"
      }
    });

    expect(result.mode).toEqual({
      mode: "audit",
      source: "default"
    });
    expect(result.action).toBe("allowed");
    expect(result.blocked).toBe(false);
    expect(result.bypass.detected).toBe(true);
  });

  it("blocks bypass only when strict mode is explicit or selected by benchmark profile", () => {
    const explicit = evaluateGatewayEnvelope({
      ...gatewayInput(),
      bypass: {
        attempted_operation: "agent.direct_write",
        detected: true,
        reason: "agent attempted direct storage write"
      },
      strict: true
    });
    const benchmark = evaluateGatewayEnvelope({
      ...gatewayInput(),
      benchmarkProfile: {
        gateway_strict: true,
        profile_id: "benchmark-strict"
      },
      bypass: {
        attempted_operation: "agent.direct_write",
        detected: true,
        reason: "agent attempted direct storage write"
      }
    });
    const noBypass = evaluateGatewayEnvelope({
      ...gatewayInput(),
      strict: true
    });

    expect(explicit.action).toBe("blocked");
    expect(explicit.mode.source).toBe("explicit_flag");
    expect(benchmark.action).toBe("blocked");
    expect(benchmark.mode.source).toBe("benchmark_profile");
    expect(noBypass.action).toBe("allowed");
  });

  it("links session, context, provider, and proposal evidence without durable truth or usage proof claims", () => {
    const result = evaluateGatewayEnvelope(gatewayInput());

    expect(result.evidence_links).toMatchObject({
      context: {
        context_pack_id: "context-pack-1",
        delivered_context_counts_as_usage_proof: false,
        delivery_id: "delivery-1",
        outcome: "delivered"
      },
      proposal: {
        durable_truth: false,
        proposal_id: "proposal-1"
      },
      provider: {
        decision_id: "provider-selection-1",
        status: "selected"
      },
      session: {
        event_id: "event-context-delivered",
        run_id: "run-1",
        session_id: "session-1",
        workspace_id: "workspace-1"
      }
    });
    expect(result.audit_evidence_refs).toEqual(expect.arrayContaining([
      "gateway:session:session-1",
      "gateway:context:context-pack-1",
      "gateway:provider:provider-selection-1",
      "gateway:proposal:proposal-1"
    ]));
    expect(result.durable_truth_written).toBe(false);
    expect(result.counts_as_usage_proof).toBe(false);
  });

  it("resolves strictness source without making strict the default", () => {
    expect(resolveGatewayMode({})).toEqual({ mode: "audit", source: "default" });
    expect(resolveGatewayMode({ strict: true })).toEqual({ mode: "strict", source: "explicit_flag" });
    expect(resolveGatewayMode({
      benchmarkProfile: {
        gateway_strict: true,
        profile_id: "strict-profile"
      }
    })).toEqual({ mode: "strict", source: "benchmark_profile" });
  });

  it("rejects forged or mismatched gateway evidence before creating audit refs", () => {
    expect(() => evaluateGatewayEnvelope({
      ...gatewayInput(),
      operation: "unknown.operation" as "recall.context.assemble"
    })).toThrow(/operation/);

    expect(() => evaluateGatewayEnvelope({
      ...gatewayInput(),
      context: {
        ...contextDelivery(),
        session_id: "other-session"
      }
    })).toThrow(/context.session_id/);

    expect(() => evaluateGatewayEnvelope({
      ...gatewayInput(),
      session: {
        ...sessionEvent(),
        recorded_at: "not-a-date"
      }
    })).toThrow(/recorded_at/);

    expect(() => evaluateGatewayEnvelope({
      ...gatewayInput(),
      proposal: {
        accepted: false,
        auditable: true,
        durable_truth: false,
        lifecycle_state: "rejected",
        proposal: {
          ...proposal(),
          evidence_refs: []
        },
        reasons: ["missing_evidence"]
      }
    })).toThrow(/accepted proposal validation result/);
  });
});

function gatewayInput(): Parameters<typeof evaluateGatewayEnvelope>[0] {
  return {
    context: contextDelivery(),
    operation: "recall.context.assemble",
    proposal: proposal(),
    provider: providerSelection(),
    recorded_at: now,
    session: sessionEvent(),
    target_agent: "codex"
  };
}

function sessionEvent(): MemorySessionEvent {
  return {
    activation_mode: "gateway",
    agent_target: "codex",
    delivery: contextDelivery(),
    event_id: "event-context-delivered",
    evidence_refs: ["audit:context-pack-delivery"],
    profile_scope: "project",
    recorded_at: now,
    run_id: "run-1",
    session_id: "session-1",
    source_ref: "runtime:context-pack",
    type: "context_delivered",
    workspace_id: "workspace-1"
  };
}

function contextDelivery(): ContextDeliveryRecord {
  return {
    activation_mode: "gateway",
    context_pack_id: "context-pack-1",
    delivered_at: now,
    delivery_id: "delivery-1",
    evidence_refs: ["audit:context-pack-delivery"],
    memory_ids: ["memory-1"],
    outcome: "delivered",
    profile_scope: "project",
    reason: null,
    run_id: "run-1",
    session_id: "session-1",
    source_ref: "runtime:context-pack",
    target_agent: "codex",
    workspace_id: "workspace-1"
  };
}

function providerSelection(): ProviderSelectionResult {
  return {
    capability: "proposal",
    decision_id: "provider-selection-1",
    degraded: false,
    rejected_provider_ids: [],
    required: true,
    selected_provider: null,
    selection_reason: "selected provider",
    status: "selected"
  };
}

function proposal(): ProposalRecord {
  return {
    created_at: now,
    durable_truth: false,
    evidence_refs: ["evidence-1"],
    governance_outcome: "candidate",
    lifecycle_state: "candidate",
    proposal_id: "proposal-1",
    proposed_content_ref: "proposal-content-1",
    provider_decision_id: "provider-selection-1",
    rejection_reason: null,
    scope: {
      run_id: "run-1",
      scope_class: "project",
      scope_ref: "workspace-1",
      surface_id: null,
      workspace_id: "workspace-1"
    },
    source: {
      kind: "provider",
      ref: "provider-a"
    },
    source_refs: ["source-1"],
    target_dimension: "fact",
    validation_errors: []
  };
}
