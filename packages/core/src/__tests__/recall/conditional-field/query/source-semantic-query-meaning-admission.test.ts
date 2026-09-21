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
import { compileSourceSemanticQueryProgram } from "../../../../recall/conditional-field/query/compile-source-semantic-query.js";

const ORIGINAL = "Who sent the sample to Mira?";

describe("source semantic query meaning admission", () => {
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
        meaning: {
          kind: "statement", key: "send", predicate: "send",
          arguments: [
            { role: "sender", target: { kind: "free", key: "sender" }, excerpt: "Who" },
            { role: "theme", target: { kind: "named", key: "sample", excerpt: "sample" }, excerpt: "sample" },
            { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" }, excerpt: "Mira" }
          ]
        }
      }],
      return: ["sender"],
      gaps: []
    }, {
      original_query_digest: digestOriginalQuery(ORIGINAL),
      producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
      producer_version: "1"
    });
    const admission = admitSourceSemanticQuery(query, ORIGINAL);
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") return;
    expect(admission.query.contract).toBe(SOURCE_SEMANTIC_QUERY_CONTRACT);
    expect(admission.query.variables.find((row) => row.id === "sender")?.sort).toBe("entity");
    expect(admission.query.variables.find((row) => row.id === "send")?.sort).toBe("proposition");
    const program = compileSourceSemanticQueryProgram(admission.query, new SourceSemanticResourceLedger({
      work_units: 200000, memory_bytes: 20000000
    }));
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
