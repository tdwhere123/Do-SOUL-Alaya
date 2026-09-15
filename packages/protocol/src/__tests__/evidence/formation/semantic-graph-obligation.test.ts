import { describe, expect, it } from "vitest";
import { evidenceFactFrameGraphIsComplete, groundEvidenceFactFrameObligation } from "../../../evidence/formation/evidence-osf-semantic-completeness.js";
import { groundOpenSemanticFactorGraph, type OpenSemanticFactorGraphProposal } from "../../../relations/open-semantic-factor-graph.js";

const source = "I use Atlas for research.";
const frame = { schema_version: 1 as const, slots: [
  { role: "subject" as const, text: "I" },
  { role: "relation" as const, text: "use" },
  { role: "value" as const, text: "Atlas" },
  { role: "qualifier" as const, text: "for research" }
] };
const graph: OpenSemanticFactorGraphProposal = {
  schema_version: 2, source_kind: "evidence",
  factors: [
    { factor_id: "actor", surface: "I", source_occurrence: 0, semantic_identity: "speaker" },
    { factor_id: "predicate", surface: "use", source_occurrence: 0, semantic_identity: "use" },
    { factor_id: "object", surface: "Atlas", source_occurrence: 0, semantic_identity: "atlas" },
    { factor_id: "purpose", surface: "for research", source_occurrence: 0, semantic_identity: "research" }
  ], variables: [], result_variable_ids: [],
  propositions: [{ proposition_id: "use", predicate_factor_id: "predicate", arguments: [
    { position: 0, binding_identity: "actor", reference_kind: "factor", reference_id: "actor" },
    { position: 1, binding_identity: "purpose", reference_kind: "factor", reference_id: "purpose" },
    { position: 2, binding_identity: "object", reference_kind: "factor", reference_id: "object" }
  ] }]
};

describe("source bound semantic graph obligation", () => {
  it("requires the predicate and ordered source-exact subject, qualifier and value", () => {
    expect(groundEvidenceFactFrameObligation(source, frame)).toEqual({
      predicate: { role: "relation", surface: "use", source_span: [2, 5], position: null },
      arguments: [
        { role: "subject", surface: "I", source_span: [0, 1], position: 0 },
        { role: "qualifier", surface: "for research", source_span: [12, 24], position: 1 },
        { role: "value", surface: "Atlas", source_span: [6, 11], position: 2 }
      ]
    });
    expect(evidenceFactFrameGraphIsComplete({ source_text: source, fact_frame: frame, graph })).toBe(true);
    const grounded = groundOpenSemanticFactorGraph(graph, source)!;
    expect(evidenceFactFrameGraphIsComplete({ source_text: source, fact_frame: frame, graph: grounded })).toBe(true);
  });

  it("rejects missing qualifier, wrong predicate, reordered arguments and extra propositions", () => {
    const proposition = graph.propositions[0]!;
    const variants = [
      { ...proposition, arguments: proposition.arguments.slice(0, 2) },
      { ...proposition, predicate_factor_id: "object" },
      { ...proposition, arguments: [...proposition.arguments].reverse() }
    ];
    for (const variant of variants) {
      expect(evidenceFactFrameGraphIsComplete({ source_text: source, fact_frame: frame,
        graph: { ...graph, propositions: [variant] } })).toBe(false);
    }
    expect(evidenceFactFrameGraphIsComplete({ source_text: source, fact_frame: frame,
      graph: { ...graph, propositions: [proposition, { ...proposition, proposition_id: "extra" }] } })).toBe(false);
  });

  it("fails closed for malformed or ungrounded frames and incomplete source roles", () => {
    expect(evidenceFactFrameGraphIsComplete({ source_text: source, fact_frame: {}, graph })).toBe(false);
    expect(evidenceFactFrameGraphIsComplete({ source_text: "Something else.", fact_frame: frame, graph })).toBe(false);
    expect(groundEvidenceFactFrameObligation(source, { ...frame, slots: frame.slots.slice(1) })).toBeNull();
  });
});
