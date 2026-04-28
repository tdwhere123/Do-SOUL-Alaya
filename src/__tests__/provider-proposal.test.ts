import { describe, expect, it } from "vitest";
import {
  createRejectedProposalRecord,
  selectProviderForCapability,
  summarizeBackgroundProposalJob,
  validateProposalRecord
} from "../provider/index.js";
import type { ProposalRecord, ProviderHealthState, ProviderRegistryEntry } from "../provider/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("provider capability selection", () => {
  it("selects deterministically by priority and stable tie-break", () => {
    const samePriorityA = provider({
      provider_id: "provider-b",
      priority: 10,
      capabilities: ["proposal"],
      model_ref: "model-b"
    });
    const samePriorityB = provider({
      provider_id: "provider-a",
      priority: 10,
      capabilities: ["proposal"],
      model_ref: "model-a"
    });
    const lowerPriority = provider({
      provider_id: "provider-z",
      priority: 20,
      capabilities: ["proposal"],
      model_ref: "model-z"
    });

    const firstOrder = selectProviderForCapability([samePriorityA, lowerPriority, samePriorityB], {
      capability: "proposal",
      decision_id: "selection-1",
      required: true,
      scope_ref: "workspace-1"
    });
    const reverseOrder = selectProviderForCapability([lowerPriority, samePriorityB, samePriorityA], {
      capability: "proposal",
      decision_id: "selection-1",
      required: true,
      scope_ref: "workspace-1"
    });

    expect(firstOrder.status).toBe("selected");
    expect(firstOrder.selected_provider?.provider_id).toBe("provider-a");
    expect(reverseOrder.selected_provider?.provider_id).toBe("provider-a");
    expect(firstOrder.selection_reason).toContain("priority=10");
    expect(firstOrder.selection_reason).toContain("tie_break=provider-a");
  });

  it("fails closed for required capabilities and degrades optional capabilities by policy", () => {
    const unavailable = provider({
      provider_id: "provider-unavailable",
      capabilities: ["embedding"],
      health: health("unavailable", "network_down")
    });
    const disabled = provider({
      provider_id: "provider-disabled",
      capabilities: ["embedding"],
      health: health("disabled", "operator_disabled")
    });
    const degraded = provider({
      provider_id: "provider-degraded",
      capabilities: ["embedding"],
      health: health("degraded", "rate_limited")
    });

    expect(selectProviderForCapability([provider({ capabilities: ["proposal"] })], {
      capability: "embedding",
      decision_id: "selection-missing-required",
      required: true,
      scope_ref: "workspace-1"
    })).toMatchObject({
      status: "failed_closed",
      selected_provider: null,
      degraded: false
    });

    expect(selectProviderForCapability([unavailable, disabled], {
      capability: "embedding",
      decision_id: "selection-unavailable-required",
      required: true,
      scope_ref: "workspace-1"
    })).toMatchObject({
      status: "failed_closed",
      selected_provider: null,
      degraded: false
    });

    const optional = selectProviderForCapability([degraded], {
      allow_degraded: true,
      capability: "embedding",
      decision_id: "selection-optional-degraded",
      required: false,
      scope_ref: "workspace-1"
    });
    expect(optional.status).toBe("degraded");
    expect(optional.selected_provider?.provider_id).toBe("provider-degraded");
    expect(optional.selection_reason).toContain("optional_degraded_provider_selected");

    expect(selectProviderForCapability([], {
      capability: "rerank",
      decision_id: "selection-optional-missing",
      required: false,
      scope_ref: "workspace-1"
    })).toMatchObject({
      status: "degraded",
      selected_provider: null,
      degraded: true
    });
  });
});

describe("proposal records", () => {
  it("accepts only candidate proposal records and never durable truth", () => {
    const result = validateProposalRecord(validProposal());

    expect(result).toMatchObject({
      accepted: true,
      auditable: true,
      durable_truth: false,
      lifecycle_state: "candidate",
      reasons: []
    });
  });

  it("turns missing source, evidence, or scope into auditable rejected proposal data", () => {
    const result = validateProposalRecord({
      ...validProposal(),
      evidence_refs: [],
      scope: null,
      source: null,
      source_refs: []
    });

    expect(result.accepted).toBe(false);
    expect(result.auditable).toBe(true);
    expect(result.durable_truth).toBe(false);
    expect(result.lifecycle_state).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "source_missing",
      "source_refs_missing",
      "evidence_missing",
      "scope_missing"
    ]));
    expect(result.proposal.lifecycle_state).toBe("rejected");
    expect(result.proposal.rejection_reason).toContain("source_missing");
  });

  it("rejects durable lifecycle or governance outcomes as bypass attempts", () => {
    const result = validateProposalRecord({
      ...validProposal(),
      governance_outcome: "durable",
      lifecycle_state: "durable"
    } as unknown as ProposalRecord);

    expect(result.accepted).toBe(false);
    expect(result.lifecycle_state).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining(["durable_truth_bypass_attempt"]));
    expect(result.proposal.durable_truth).toBe(false);
  });

  it("creates explicit rejected proposal records for failed provider output", () => {
    const rejected = createRejectedProposalRecord({
      ...validProposal("proposal-rejected"),
      evidence_refs: [],
      scope: null,
      source: null,
      source_refs: []
    }, "provider_timeout");
    const result = validateProposalRecord(rejected);

    expect(rejected.lifecycle_state).toBe("rejected");
    expect(rejected.rejection_reason).toBe("provider_timeout");
    expect(rejected.validation_errors).toContain("provider_timeout");
    expect(result.accepted).toBe(false);
    expect(result.auditable).toBe(true);
    expect(result.durable_truth).toBe(false);
  });
});

describe("background proposal job outcomes", () => {
  it("summarizes background failure without implying main-turn failure", () => {
    const accepted = validateProposalRecord(validProposal("proposal-background-ok"));
    const rejected = validateProposalRecord(createRejectedProposalRecord(
      validProposal("proposal-background-rejected"),
      "provider_timeout"
    ));

    const summary = summarizeBackgroundProposalJob({
      failure_reason: "provider_timeout",
      job_id: "job-1",
      proposal_results: [accepted, rejected],
      provider_decision_id: "selection-1",
      run_id: "run-1",
      status: "failed",
      workspace_id: "workspace-1"
    });

    expect(summary.status).toBe("failed");
    expect(summary.main_turn_failed).toBe(false);
    expect(summary.main_turn_outcome).toBe("unchanged");
    expect(summary.durable_truth_written).toBe(false);
    expect(summary.accepted_count).toBe(1);
    expect(summary.rejected_count).toBe(1);
    expect(summary.audit_reasons).toEqual(expect.arrayContaining(["provider_timeout"]));
  });
});

function provider(overrides: Partial<ProviderRegistryEntry> = {}): ProviderRegistryEntry {
  return {
    capabilities: ["proposal"],
    config_ref: "config:provider",
    health: health("enabled"),
    model_ref: "model-default",
    priority: 10,
    provider_id: "provider-default",
    provider_kind: "local",
    scope_refs: ["workspace-1"],
    ...overrides
  };
}

function health(status: ProviderHealthState["status"], reason: string | null = null): ProviderHealthState {
  return {
    checked_at: now,
    reason,
    status
  };
}

function validProposal(proposalId = "proposal-1"): ProposalRecord {
  return {
    created_at: now,
    durable_truth: false,
    evidence_refs: ["evidence-1"],
    governance_outcome: "candidate",
    lifecycle_state: "candidate",
    proposal_id: proposalId,
    proposed_content_ref: "proposal-content-1",
    provider_decision_id: "selection-1",
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
