import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SourceSemanticResourceLedger,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  materializeSourceSemanticQueryMeaning, sourceSemanticQueryBranchViews,
  type QueryProgram, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query-identity.js";
import { compileSourceSemanticGroupProgram } from "../../../../recall/conditional-field/query/compile-source-semantic-query.js";
import { admitSourceSemanticQuery } from "../../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "../../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { sourceSemanticRelationKey } from "../../../../recall/runtime/source-semantic-premises.js";

const courierQuestion = "Which courier carries the parcel that Mira inspects?";
const existentialCourierQuestion = "Which courier carries a parcel that Mira inspects?";
const countQuestion = "Does tray J hold more red tokens than blue tokens?";
const reportQuestion = "Which witness reported that Nia opened the blue crate?";

function admitMeaning(original: string, body: unknown): SourceSemanticQuery {
  const query = materializeSourceSemanticQueryMeaning(body, {
    original_query: original, original_query_digest: digestOriginalQuery(original),
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1",
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION
  });
  const admission = admitSourceSemanticQuery(query, original);
  if (admission.kind !== "admitted") throw new Error(`authored query was ${admission.kind}`);
  return admission.query;
}

function relationKinds(program: QueryProgram): string[] {
  if (program.kind === "relation") return [program.relation_kind];
  if (program.kind === "sequence") return program.steps.flatMap(relationKinds);
  throw new Error(`unexpected compiled program kind ${program.kind}`);
}

function compile(query: SourceSemanticQuery, branch = 0): string[] {
  const view = sourceSemanticQueryBranchViews(query.alternatives[0]!)[branch]!;
  const program = compileSourceSemanticGroupProgram(query, view.alternative, 0,
    new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 }),
    undefined, undefined, branch);
  return relationKinds(program);
}

function courierMeaning(parcelKind: "named" | "free") {
  const parcelExcerpt = parcelKind === "named" ? "the parcel" : "a parcel";
  return {
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    alternatives: [{ conditions: [
      { kind: "statement", key: "carry", predicate: "carry", arguments: [
        { role: "agent", target: { kind: "free", key: "courier", excerpt: "Which courier", return: true } },
        { role: "theme", target: { kind: parcelKind, key: "parcel", excerpt: parcelExcerpt } }
      ] },
      { kind: "statement", key: "inspect", predicate: "inspect", arguments: [
        { role: "agent", target: { kind: "named", key: "mira", excerpt: "Mira" } },
        { role: "theme", target: { kind: "reference", key: "parcel" }, excerpt: parcelExcerpt }
      ] }
    ] }]
  };
}

function reportedAsRole(roleExcerpt?: string) {
  return {
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    alternatives: [{ conditions: [
      { kind: "statement", key: "report", predicate: "report", arguments: [
        { role: "speaker", target: { kind: "free", key: "witness", excerpt: "Which witness", return: true } },
        { role: "content", target: { kind: "reference", key: "open" },
          ...(roleExcerpt === undefined ? {} : { excerpt: roleExcerpt }) }
      ] },
      { kind: "statement", key: "open", predicate: "open", arguments: [
        { role: "agent", target: { kind: "named", key: "nia", excerpt: "Nia" } },
        { role: "theme", target: { kind: "named", key: "crate", excerpt: "the blue crate" } }
      ] }
    ] }]
  };
}

describe("authored semantic query admission controls", () => {
  it("retains shared parcel incidence while requiring a referent only for the definite parcel", () => {
    const named = admitMeaning(courierQuestion, courierMeaning("named"));
    const free = admitMeaning(existentialCourierQuestion, courierMeaning("free"));
    for (const query of [named, free]) {
      expect(query.return_variables).toEqual(["courier"]);
      expect(query.alternatives[0]!.frames.flatMap(frame => frame.role_requirements)
        .filter(role => role.target_variable === "parcel")).toHaveLength(2);
    }
    expect(named.variables.find(row => row.id === "parcel")?.reference?.excerpt).toBe("the parcel");
    expect(free.variables.find(row => row.id === "parcel")?.reference).toBeUndefined();
    expect(compile(named)).toContain(sourceSemanticRelationKey("semantic_correspondence_referent", "parcel"));
    expect(compile(free)).not.toContain(sourceSemanticRelationKey("semantic_correspondence_referent", "parcel"));
  });

  it("compiles a directly stated Boolean answer separately from independently useful count inputs", () => {
    const query = admitMeaning(countQuestion, {
      contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
      requested_operation: { reading: "Compare the red and blue token counts in tray J.",
        support: { kind: "query_text", excerpt: "more red tokens than blue tokens" } },
      entities: [
        { kind: "named", key: "tray", excerpt: "tray J" },
        { kind: "named", key: "red", excerpt: "red tokens" },
        { kind: "named", key: "blue", excerpt: "blue tokens" }
      ],
      alternatives: [{
        conditions: [{ kind: "statement", key: "more", predicate: "hold more than", arguments: [
          { role: "container", target: { kind: "reference", key: "tray" } },
          { role: "greater population", target: { kind: "reference", key: "red" } },
          { role: "lesser population", target: { kind: "reference", key: "blue" } }
        ] }],
        evidence_inputs: [
          { conditions: [{ kind: "statement", key: "red_count", predicate: "count", arguments: [
            { role: "container", target: { kind: "reference", key: "tray" } },
            { role: "population", target: { kind: "reference", key: "red" } },
            { role: "value", target: { kind: "free", key: "red_value", excerpt: "red tokens" } }
          ] }] },
          { conditions: [{ kind: "statement", key: "blue_count", predicate: "count", arguments: [
            { role: "container", target: { kind: "reference", key: "tray" } },
            { role: "population", target: { kind: "reference", key: "blue" } },
            { role: "value", target: { kind: "free", key: "blue_value", excerpt: "blue tokens" } }
          ] }] }
        ]
      }]
    });
    const views = sourceSemanticQueryBranchViews(query.alternatives[0]!);
    expect(query.return_variables).toEqual([]);
    expect(views.map(view => view.target)).toEqual([
      { kind: "answer" }, { kind: "evidence", input: 0 }, { kind: "evidence", input: 1 }
    ]);
    expect(views.map(view => view.alternative.frames.map(frame => frame.id))).toEqual([
      ["more"], ["red_count"], ["blue_count"]
    ]);
    for (const index of [0, 1, 2]) expect(compile(query, index).length).toBeGreaterThan(0);
    expect(compile(query, 1)).not.toContain(sourceSemanticRelationKey("semantic_correspondence_predicate", 0, "more"));
    expect(compile(query, 2)).not.toContain(sourceSemanticRelationKey("semantic_correspondence_predicate", 0, "more"));
  });

  it("keeps a reported event embedded rather than asserting it as a second root", () => {
    const query = admitMeaning(reportQuestion, {
      contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
      alternatives: [{ conditions: [{ kind: "statement", key: "report", predicate: "report",
        arguments: [{ role: "speaker", target: { kind: "free", key: "witness", excerpt: "Which witness", return: true } }],
        content: { kind: "statement", key: "open", predicate: "open", arguments: [
          { role: "agent", target: { kind: "named", key: "nia", excerpt: "Nia" } },
          { role: "theme", target: { kind: "named", key: "crate", excerpt: "the blue crate" } }
        ] }
      }] }]
    });
    expect(query.alternatives[0]!.context_obligations).toEqual([
      { frame: "report", kind: "asserted_at_source" },
      { frame: "open", kind: "explicit_embedded_structure",
        incidence: { kind: "embedding", other_frame: "report", role: "content" } }
    ]);
    expect(compile(query)).toContain(sourceSemanticRelationKey("source_interpretation_embedded"));
  });

  it("admits exact role support without mistaking support repair for embedded scope", () => {
    expect(() => admitMeaning(reportQuestion, reportedAsRole())).toThrow(/requires explicit query text support/u);
    const repaired = admitMeaning(reportQuestion, reportedAsRole("Nia opened the blue crate"));
    expect(repaired.alternatives[0]!.frames[0]!.role_requirements[1]!.support.excerpt)
      .toBe("Nia opened the blue crate");
    expect(repaired.alternatives[0]!.context_obligations).toEqual([
      { frame: "report", kind: "asserted_at_source" },
      { frame: "open", kind: "asserted_at_source" }
    ]);
    expect(compile(repaired)).not.toContain(sourceSemanticRelationKey("source_interpretation_embedded"));
  });
});
