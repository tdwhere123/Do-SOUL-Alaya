import { describe, expect, it } from "vitest";
import { MemoryDimension, ScopeClass } from "../../index.js";
import { MemorySearchResultSchema } from "../../soul/mcp-types.js";
import { RecallCandidateSchema } from "../../soul/recall-candidate.js";
import {
  StagedWarningArraySchema,
  StagedWarningKind,
  StagedWarningResolutionOption,
  StagedWarningSchema,
  StagedWarningSeverity
} from "../../soul/staged-warning.js";

const baseCandidate = {
  object_id: "memory-1",
  object_kind: "memory_entry",
  activation_score: 0.7,
  relevance_score: 0.64,
  content_preview: "Prefer pnpm.",
  token_estimate: 7,
  manifestation: "excerpt",
  dimension: MemoryDimension.PROCEDURE,
  scope_class: ScopeClass.PROJECT
} as const;

const baseSearchResult = {
  object_id: "memory-1",
  object_kind: "memory_entry",
  relevance_score: 0.64,
  content_preview: "Prefer pnpm.",
  evidence_pointers: ["memory-1"],
  selection_reason: "lexical and activation.",
  source_channels: ["workspace_local", "keyword"],
  score_factors: { activation: 0.7, relevance: 0.64 },
  budget_state: {
    token_estimate: 7,
    max_entries: 5,
    max_total_tokens: 2000,
    remaining_entries: 4,
    remaining_tokens: 1993,
    within_budget: true
  }
} as const;

describe("StagedWarning protocol schema", () => {
  it("accepts every documented kind / severity / resolution option", () => {
    const warning = StagedWarningSchema.parse({
      kind: StagedWarningKind.CONTRADICTION_PENDING,
      severity: StagedWarningSeverity.BLOCKING,
      policy: "conflict_detection.v1",
      summary: "Contradicts memory-42; resolve before citing as durable truth.",
      target_object_id: "memory-1",
      resolution_options: [
        StagedWarningResolutionOption.ACCEPT_PENDING,
        StagedWarningResolutionOption.REJECT_PENDING,
        StagedWarningResolutionOption.ESCALATE_HUMAN
      ]
    });

    expect(warning.kind).toBe("contradiction_pending");
    expect(warning.severity).toBe("blocking");
    expect(warning.policy).toBe("conflict_detection.v1");
    expect(warning.target_object_id).toBe("memory-1");
    expect(warning.resolution_options).toEqual([
      "accept_pending",
      "reject_pending",
      "escalate_human"
    ]);
  });

  it("rejects unknown kind / severity / resolution option values via strict enums", () => {
    expect(
      StagedWarningSchema.safeParse({
        kind: "novel_reason",
        severity: "info",
        policy: "p",
        summary: "s",
        resolution_options: []
      }).success
    ).toBe(false);

    expect(
      StagedWarningSchema.safeParse({
        kind: StagedWarningKind.LOW_CONFIDENCE,
        severity: "critical",
        policy: "p",
        summary: "s",
        resolution_options: []
      }).success
    ).toBe(false);

    expect(
      StagedWarningSchema.safeParse({
        kind: StagedWarningKind.LOW_CONFIDENCE,
        severity: StagedWarningSeverity.INFO,
        policy: "p",
        summary: "s",
        resolution_options: ["forge"]
      }).success
    ).toBe(false);
  });

  it("rejects unknown fields at parse time (strict)", () => {
    expect(
      StagedWarningSchema.safeParse({
        kind: StagedWarningKind.LOW_CONFIDENCE,
        severity: StagedWarningSeverity.INFO,
        policy: "p",
        summary: "s",
        resolution_options: [],
        smuggled: true
      }).success
    ).toBe(false);
  });

  it("accepts an empty resolution_options list for human-inbox-only warnings", () => {
    const warning = StagedWarningSchema.parse({
      kind: StagedWarningKind.EVIDENCE_MISSING,
      severity: StagedWarningSeverity.WARNING,
      policy: "evidence_gate.v1",
      summary: "Pointer is missing a verifiable evidence ref.",
      resolution_options: []
    });

    expect(warning.resolution_options).toEqual([]);
  });

  it("parses a multi-warning array through the bounded array schema", () => {
    const warnings = StagedWarningArraySchema.parse([
      {
        kind: StagedWarningKind.LOW_CONFIDENCE,
        severity: StagedWarningSeverity.INFO,
        policy: "confidence_floor.v1",
        summary: "confidence below 0.3.",
        resolution_options: [StagedWarningResolutionOption.DEFER]
      },
      {
        kind: StagedWarningKind.SUPERSEDE_CANDIDATE,
        severity: StagedWarningSeverity.WARNING,
        policy: "supersede.v1",
        summary: "memory-7 may supersede this row.",
        resolution_options: [
          StagedWarningResolutionOption.ACCEPT_PENDING,
          StagedWarningResolutionOption.REJECT_PENDING
        ]
      }
    ]);

    expect(warnings).toHaveLength(2);
  });
});

describe("RecallCandidate staged_warnings round trip", () => {
  it("round-trips staged_warnings on a recall candidate", () => {
    const candidate = RecallCandidateSchema.parse({
      ...baseCandidate,
      staged_warnings: [
        {
          kind: StagedWarningKind.CONTRADICTION_PENDING,
          severity: StagedWarningSeverity.BLOCKING,
          policy: "conflict_detection.v1",
          summary: "contradicts memory-42.",
          target_object_id: "memory-1",
          resolution_options: [StagedWarningResolutionOption.ESCALATE_HUMAN]
        }
      ]
    });

    expect(candidate.staged_warnings).toEqual([
      {
        kind: "contradiction_pending",
        severity: "blocking",
        policy: "conflict_detection.v1",
        summary: "contradicts memory-42.",
        target_object_id: "memory-1",
        resolution_options: ["escalate_human"]
      }
    ]);
  });

  it("treats staged_warnings as optional so older candidates still parse", () => {
    const candidate = RecallCandidateSchema.parse(baseCandidate);
    expect(candidate.staged_warnings).toBeUndefined();
  });
});

describe("MemorySearchResult staged_warnings round trip", () => {
  it("round-trips staged_warnings on the public recall result", () => {
    const result = MemorySearchResultSchema.parse({
      ...baseSearchResult,
      staged_warnings: [
        {
          kind: StagedWarningKind.LOW_CONFIDENCE,
          severity: StagedWarningSeverity.INFO,
          policy: "confidence_floor.v1",
          summary: "confidence 0.22 below floor 0.3.",
          target_object_id: "memory-1",
          resolution_options: [StagedWarningResolutionOption.DEFER]
        }
      ]
    });

    expect(result.staged_warnings).toEqual([
      {
        kind: "low_confidence",
        severity: "info",
        policy: "confidence_floor.v1",
        summary: "confidence 0.22 below floor 0.3.",
        target_object_id: "memory-1",
        resolution_options: ["defer"]
      }
    ]);
  });

  it("accepts older payloads that omit staged_warnings", () => {
    const result = MemorySearchResultSchema.parse(baseSearchResult);
    expect(result.staged_warnings).toBeUndefined();
  });
});
