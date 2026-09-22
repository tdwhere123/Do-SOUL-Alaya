import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SourceSemanticResourceLedger, materializeSourceSemanticQueryMeaning
} from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query-identity.js";
import { admitSourceSemanticQuery } from "../../../../recall/conditional-field/query/source-semantic-query-admission.js";
import {
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_GRAPH_SYNTAX,
  SOURCE_SEMANTIC_QUERY_MEANING_SYNTAX, defaultSourceSemanticQueryProducerRegistry
} from "../../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { compileSourceSemanticGroupProgram } from "../../../../recall/conditional-field/query/compile-source-semantic-query.js";

const ORIGINAL = "Who sent the sample to Mira?";

describe("source semantic query meaning admission", () => {
  it.each(["person", "Who", "reportingEntity", "x73"])("grounds a free reporter independently of its handle %s", (key) => {
    const original = "Who reported that Lee left?";
    const query = reportedQuery(original, { kind: "free", key, excerpt: "Who" }, { return: [key] });
    expect(admitSourceSemanticQuery(query, original).kind).toBe("admitted");
    expect(query.alternatives[0]!.frames[0]!.role_requirements).toEqual([
      { id: "reporter", role_reading: "reporter", target_variable: key, support: { kind: "query_text", excerpt: "Who" } }
    ]);
    expect(query.variables.find(row => row.id === key)?.reference).toBeUndefined();
    expect(query.alternatives[0]!.context_obligations).toEqual([
      { frame: "report", kind: "asserted_at_source" },
      { frame: "leave", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "report", role: "content" } }
    ]);
  });

  it.each([
    { original: "Mira reported that Lee left?", declaration: { kind: "named", key: "speaker", excerpt: "Mira" } },
    { original: "Who reported that Lee left?", declaration: { kind: "free", key: "speaker", excerpt: "Who" } }
  ])("reuses declared reporter support without repeating its excerpt: $original", ({ original, declaration }) => {
    const query = reportedQuery(original, { kind: "reference", key: "speaker" }, { entities: [declaration] });
    expect(admitSourceSemanticQuery(query, original).kind).toBe("admitted");
    expect(query.alternatives[0]!.frames[0]!.role_requirements[0]!.support.excerpt).toBe(declaration.excerpt);
  });

  it("rejects absent and fabricated reporter support without treating a matching handle as evidence", () => {
    const original = "Who reported that Lee left?";
    for (const key of ["person", "Who"]) {
      expect(() => reportedQuery(original, { kind: "free", key })).toThrow(/requires query text support/u);
    }
    expect(() => reportedQuery(original, { kind: "reference", key: "missing" })).toThrow(/undeclared local reference/u);
    expect(admitSourceSemanticQuery(reportedQuery(original, { kind: "free", key: "person", excerpt: "invented" }), original).kind).toBe("invalid");
  });

  it("registers meaning syntax without occupying the canonical graph version", () => {
    const record = defaultSourceSemanticQueryProducerRegistry.lookup(SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, "1");
    expect(record?.syntaxes).toEqual([SOURCE_SEMANTIC_QUERY_GRAPH_SYNTAX, SOURCE_SEMANTIC_QUERY_MEANING_SYNTAX]);
    expect(SOURCE_SEMANTIC_QUERY_GRAPH_SYNTAX).toBe(SOURCE_SEMANTIC_QUERY_CONTRACT);
    expect(SOURCE_SEMANTIC_QUERY_MEANING_SYNTAX).toBe(SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT);
    expect(SOURCE_SEMANTIC_QUERY_MEANING_SYNTAX).not.toBe(SOURCE_SEMANTIC_QUERY_GRAPH_SYNTAX);
  });

  it("admits a materialized meaning proposal and compiles the canonical query", () => {
    const query = materializeSourceSemanticQueryMeaning({
      contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
      alternatives: [{
        conditions: [{
          kind: "statement", key: "send", predicate: "send",
          arguments: [
            { role: "sender", target: { kind: "free", key: "sender" }, excerpt: "Who" },
            { role: "theme", target: { kind: "named", key: "sample", excerpt: "sample" }, excerpt: "sample" },
            { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" }, excerpt: "Mira" }
          ]
        }]
      }],
      return: ["sender"],
      gaps: []
    }, {
      original_query: ORIGINAL, original_query_digest: digestOriginalQuery(ORIGINAL),
      producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
      producer_version: "1"
    });
    const admission = admitSourceSemanticQuery(query, ORIGINAL);
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") return;
    expect(admission.query.contract).toBe(SOURCE_SEMANTIC_QUERY_CONTRACT);
    expect(admission.query.variables.find((row) => row.id === "sender")?.sort).toBe("entity");
    expect(admission.query.variables.find((row) => row.id === "send")?.sort).toBe("proposition");
    const program = compileSourceSemanticGroupProgram(admission.query, admission.query.alternatives[0]!, 0, new SourceSemanticResourceLedger({
      work_units: 200000, memory_bytes: 20000000
    }), undefined, undefined, 0);
    expect(program.kind === "sequence" || program.kind === "relation").toBe(true);
  });

  it("still rejects a malformed legacy graph instead of flipping its entity variable to an event", () => {
    const malformed = {
      contract: SOURCE_SEMANTIC_QUERY_CONTRACT,
      original_query_digest: digestOriginalQuery(ORIGINAL),
      producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
      producer_version: "1",
      contract_version: SOURCE_SEMANTIC_QUERY_CONTRACT,
      variables: [
        { id: "who", sort: "entity" as const },
        { id: "move", sort: "entity" as const }
      ],
      alternatives: [{
        frames: [{ id: "qMove", variable: "move", predicate_reading: "move", role_requirements: [] }],
        context_obligations: [{ frame: "qMove", kind: "asserted_at_source" as const }]
      }],
      return_variables: ["who"],
      gaps: []
    };
    expect(admitSourceSemanticQuery(malformed, ORIGINAL).kind).toBe("invalid");
  });
});

function reportedQuery(original: string, reporter: object, extra: object = {}) {
  return materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    alternatives: [{ conditions: [{ kind: "reported", key: "report", reporter,
      content: { kind: "statement", key: "leave", predicate: "left", arguments: [
        { role: "agent", target: { kind: "named", key: "lee", excerpt: "Lee" } }
      ] } }] }], ...extra }, { original_query: original, original_query_digest: digestOriginalQuery(original),
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" });
}
