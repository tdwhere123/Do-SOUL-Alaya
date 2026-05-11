import { describe, expect, it } from "vitest";
import {
  CandidateMemorySignalContentSchema,
  GardenCompleteTaskRequestSchema,
  GardenTaskResultEnvelopeSchema,
  SignalKind,
  SignalSource,
  SoulEmitCandidateSignalRequestSchema,
  SoulProposalCreatedPayloadSchema,
  SoulProposalResolvedPayloadSchema,
  SoulProposeMemoryUpdateRequestSchema,
  SoulSignalEmittedPayloadSchema,
  TransitionCausedBy
} from "../index.js";

const signalPayloadBase = {
  signal_id: "signal-1",
  workspace_id: "workspace-1",
  run_id: "run-1",
  source: SignalSource.MODEL_TOOL,
  signal_kind: SignalKind.POTENTIAL_PREFERENCE,
  raw_payload: { observation: "User prefers pnpm." }
} as const;

const proposalCreatedPayloadBase = {
  object_id: "proposal-1",
  object_kind: "proposal",
  workspace_id: "workspace-1",
  run_id: "run-1"
} as const;

const proposalResolvedPayloadBase = {
  ...proposalCreatedPayloadBase,
  from_state: "pending",
  to_state: "rejected",
  reason_code: "not durable enough",
  caused_by: TransitionCausedBy.REVIEW,
  evidence_refs: null,
  occurred_at: "2026-05-11T00:00:00.000Z"
} as const;

const candidateContentBase = {
  signal_kind: SignalKind.POTENTIAL_PREFERENCE,
  object_kind: "memory_entry",
  scope_hint: "project",
  domain_tags: ["tooling"],
  confidence: 0.9,
  evidence_refs: ["memory-1"],
  raw_payload: { observation: "Use pnpm." }
} as const;

describe("Trustworthy Loop source_delivery_ids protocol contracts", () => {
  it("validates signal and proposal event payload anchors as optional non-empty arrays", () => {
    expect(SoulSignalEmittedPayloadSchema.parse(signalPayloadBase)).toEqual(signalPayloadBase);
    expect(
      SoulSignalEmittedPayloadSchema.parse({
        ...signalPayloadBase,
        source_delivery_ids: ["delivery-1", "delivery-2"]
      })
    ).toMatchObject({ source_delivery_ids: ["delivery-1", "delivery-2"] });
    expect(
      SoulSignalEmittedPayloadSchema.safeParse({
        ...signalPayloadBase,
        source_delivery_ids: []
      }).success
    ).toBe(false);

    expect(SoulProposalCreatedPayloadSchema.parse(proposalCreatedPayloadBase)).toEqual(
      proposalCreatedPayloadBase
    );
    expect(
      SoulProposalCreatedPayloadSchema.parse({
        ...proposalCreatedPayloadBase,
        source_delivery_ids: ["delivery-1"]
      })
    ).toMatchObject({ source_delivery_ids: ["delivery-1"] });
    expect(
      SoulProposalCreatedPayloadSchema.safeParse({
        ...proposalCreatedPayloadBase,
        source_delivery_ids: []
      }).success
    ).toBe(false);

    expect(SoulProposalResolvedPayloadSchema.parse(proposalResolvedPayloadBase)).toEqual(
      proposalResolvedPayloadBase
    );
    expect(
      SoulProposalResolvedPayloadSchema.parse({
        ...proposalResolvedPayloadBase,
        source_delivery_ids: ["delivery-1"]
      })
    ).toMatchObject({ source_delivery_ids: ["delivery-1"] });
    expect(
      SoulProposalResolvedPayloadSchema.safeParse({
        ...proposalResolvedPayloadBase,
        source_delivery_ids: []
      }).success
    ).toBe(false);
  });

  it("keeps MCP signal/proposal anchors top-level and leaves Garden signal content anchor-free", () => {
    expect(
      SoulEmitCandidateSignalRequestSchema.parse({
        ...candidateContentBase,
        source_delivery_ids: ["delivery-1"]
      })
    ).toMatchObject({ source_delivery_ids: ["delivery-1"] });
    expect(
      SoulEmitCandidateSignalRequestSchema.safeParse({
        ...candidateContentBase,
        source_delivery_ids: []
      }).success
    ).toBe(false);
    expect(
      SoulEmitCandidateSignalRequestSchema.safeParse({
        ...candidateContentBase,
        delivery_id: "delivery-1"
      }).success
    ).toBe(false);

    expect(
      SoulProposeMemoryUpdateRequestSchema.parse({
        target_object_id: "memory-1",
        proposed_changes: { content: "Use pnpm." },
        reason: "Observed in current run.",
        source_delivery_ids: ["delivery-1", "delivery-2"]
      })
    ).toMatchObject({ source_delivery_ids: ["delivery-1", "delivery-2"] });
    expect(
      SoulProposeMemoryUpdateRequestSchema.safeParse({
        target_object_id: "memory-1",
        proposed_changes: { content: "Use pnpm." },
        reason: "Observed in current run.",
        source_delivery_ids: []
      }).success
    ).toBe(false);
    expect(
      SoulProposeMemoryUpdateRequestSchema.safeParse({
        target_object_id: "memory-1",
        proposed_changes: { content: "Use pnpm." },
        reason: "Observed in current run.",
        delivery_id: "delivery-1"
      }).success
    ).toBe(false);

    expect(CandidateMemorySignalContentSchema.parse(candidateContentBase)).toEqual(candidateContentBase);
    expect(
      CandidateMemorySignalContentSchema.safeParse({
        ...candidateContentBase,
        source_delivery_ids: ["delivery-1"]
      }).success
    ).toBe(false);
    expect(
      GardenTaskResultEnvelopeSchema.safeParse({
        candidate_signals: [
          {
            ...candidateContentBase,
            source_delivery_ids: ["delivery-1"]
          }
        ]
      }).success
    ).toBe(false);
    expect(
      GardenCompleteTaskRequestSchema.safeParse({
        task_id: "garden-task-1",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              ...candidateContentBase,
              source_delivery_ids: ["delivery-1"]
            }
          ]
        }
      }).success
    ).toBe(false);
  });
});
