import { describe, expect, it } from "vitest";
import { BoundSourceInterpretationSchema, SourceLocatedInterpretationSchema,
  SourceInterpretationResponseSchema, SOURCE_INTERPRETATION_CONTRACT } from "../../garden/source-interpretation.js";
import { CandidateMemorySignalSchema, McpEmitCandidateSignalRequestSchema } from "../../signals/candidate-memory-signal.js";

const located = {
  contract: SOURCE_INTERPRETATION_CONTRACT, artifact_key: "artifact-1",
  source_corpus_digest: "a".repeat(64),
  assertion_binding: { assertion_id: 1, source_span: [0, 12], text: "A sent mail.", context_id: "context-1" },
  outcome: "empty", candidates: [], diagnostics: []
};
const signal = {
  signal_id: "signal-1", workspace_id: "workspace-1", run_id: "run-1", surface_id: null,
  source: "garden_compile", signal_kind: "potential_semantic_observation",
  interpretation_contract: SOURCE_INTERPRETATION_CONTRACT, object_kind: null, confidence: null,
  scope_hint: "project", domain_tags: [], evidence_refs: ["evidence-1"],
  raw_payload: { source_interpretation: located },
  source_observation: { observed_at: "2026-09-14T00:00:00.000Z", authority: "trusted_host_event", source_event_id: "event-1" },
  created_at: "2026-09-14T00:00:00.000Z"
};

describe("source interpretation contracts", () => {
  it("uses positive assertion IDs and zero-based occurrences without requiring model mechanics", () => {
    const response = { interpretations: [{ assertion_id: 1, relations: [{
      predicate: { text: "sent", occurrence: 0 }, arguments: [], qualifiers: []
    }] }] };
    expect(SourceInterpretationResponseSchema.parse(response)).toEqual(response);
    expect(SourceInterpretationResponseSchema.safeParse({ confidence: 1, ...response }).success).toBe(false);
    expect(SourceInterpretationResponseSchema.safeParse({ interpretations: [{ assertion_id: 0, relations: [] }] }).success).toBe(false);
    response.interpretations[0]!.relations[0]!.predicate.occurrence = -1;
    expect(SourceInterpretationResponseSchema.safeParse(response).success).toBe(false);
  });

  it("locates an assertion before a root exists and requires the root only for publication", () => {
    expect(SourceLocatedInterpretationSchema.parse(located)).toEqual(located);
    expect(BoundSourceInterpretationSchema.safeParse(located).success).toBe(false);
    expect(BoundSourceInterpretationSchema.safeParse({ ...located, source_target: {
      kind: "source_evidence", workspace_id: "workspace-1", root_kind: "source_record",
      root_id: "root-1", source_version: "revision-1", content_digest: `sha256:${"b".repeat(64)}`, evidence_object_id: null
    } }).success).toBe(true);
    expect(SourceLocatedInterpretationSchema.safeParse({ ...located, outcome: "failed" }).success).toBe(false);
    expect(SourceLocatedInterpretationSchema.safeParse({ ...located, outcome: "failed",
      diagnostics: [{ candidate_index: null, reason: "malformed_response" }] }).success).toBe(true);
  });

  it("admits null fields only on an internal observation and preserves explicit input restrictions", () => {
    expect(CandidateMemorySignalSchema.parse(signal).confidence).toBeNull();
    expect(CandidateMemorySignalSchema.safeParse({ ...signal, confidence: 1 }).success).toBe(false);
    expect(CandidateMemorySignalSchema.safeParse({ ...signal, object_kind: "fact" }).success).toBe(false);
    expect(CandidateMemorySignalSchema.safeParse({ ...signal, supersedes_refs: ["old-memory"] }).success).toBe(false);
    expect(CandidateMemorySignalSchema.safeParse({ ...signal, source_observation: null }).success).toBe(false);
    const content = { signal_kind: "potential_claim", object_kind: "fact", confidence: 0.7,
      scope_hint: null, domain_tags: [], evidence_refs: [], raw_payload: {} };
    expect(McpEmitCandidateSignalRequestSchema.safeParse(content).success).toBe(true);
    expect(McpEmitCandidateSignalRequestSchema.safeParse({ ...content, confidence: null }).success).toBe(false);
    expect(McpEmitCandidateSignalRequestSchema.safeParse({ ...content, interpretation_contract: SOURCE_INTERPRETATION_CONTRACT }).success).toBe(false);
  });
});
