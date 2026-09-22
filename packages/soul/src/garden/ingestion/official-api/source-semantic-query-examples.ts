/** Complete neutral producer examples; their admission and incidence are tested. */
export const sourceSemanticQueryExamples = [
  {
    original_query: "Who was asked to polish the lens?",
    response: {
      contract: "source-semantic-query-response-v5", outcome: { status: "interpreted" },
      query: {
        contract: "source-semantic-query-meaning-v3", gaps: [], return: ["person"],
        alternatives: [{ conditions: [{
          kind: "statement", key: "request", predicate: "ask",
          arguments: [{ role: "recipient", target: { kind: "free", key: "person" }, excerpt: "Who" }],
          content: {
            kind: "statement", key: "action", predicate: "polish",
            arguments: [
              { role: "agent", target: { kind: "reference", key: "person" }, excerpt: "Who" },
              { role: "theme", target: { kind: "named", key: "lens", excerpt: "the lens" }, excerpt: "the lens" }
            ]
          }
        }] }]
      }
    }
  },
  {
    original_query: "Is every registered sensor calibrated?",
    response: {
      contract: "source-semantic-query-response-v5", outcome: { status: "interpreted" },
      query: {
        contract: "source-semantic-query-meaning-v3", gaps: [], return: [],
        domains: [{ key: "sensors", excerpt: "every registered sensor" }],
        evaluation: { kind: "forall", domain: "sensors", binder: "sensor", local_variables: ["sensor", "calibration"] },
        alternatives: [{ conditions: [{
          kind: "statement", key: "calibration", predicate: "calibrated",
          arguments: [{ role: "theme", target: { kind: "free", key: "sensor" }, excerpt: "sensor" }]
        }] }]
      }
    }
  },
  {
    original_query: "Who has already arrived?",
    response: {
      contract: "source-semantic-query-response-v5", outcome: { status: "interpreted" },
      query: {
        contract: "source-semantic-query-meaning-v3", return: ["person"],
        alternatives: [{ conditions: [{
          kind: "statement", key: "arrival", predicate: "arrive",
          arguments: [{ role: "agent", target: { kind: "free", key: "person" }, excerpt: "Who" }]
        }] }],
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["arrival"],
          support: [{ kind: "query_text", excerpt: "already" }],
          description: "The retained arrival predicate does not encode the requested completion qualification." }]
      }
    }
  },
  {
    original_query: "What is the ratio of amber beads to blue beads in tray T?",
    response: {
      contract: "source-semantic-query-response-v5", outcome: { status: "interpreted" },
      query: {
        contract: "source-semantic-query-meaning-v3", gaps: [], return: ["ratio"],
        requested_operation: { reading: "Divide the amber bead count by the blue bead count in tray T.",
          support: { kind: "query_text", excerpt: "ratio of amber beads to blue beads in tray T" } },
        entities: [
          { kind: "named", key: "amber", excerpt: "amber beads" },
          { kind: "named", key: "blue", excerpt: "blue beads" },
          { kind: "named", key: "tray", excerpt: "tray T" }
        ],
        alternatives: [{
          conditions: [{ kind: "statement", predicate: "ratio", arguments: [
            { role: "numerator population", target: { kind: "reference", key: "amber" } },
            { role: "denominator population", target: { kind: "reference", key: "blue" } },
            { role: "container", target: { kind: "reference", key: "tray" } },
            { role: "value", target: { kind: "free", key: "ratio", excerpt: "What is the ratio" } }
          ] }],
          evidence_inputs: [
            { conditions: [{ kind: "statement", predicate: "count", arguments: [
              { role: "population", target: { kind: "reference", key: "amber" } },
              { role: "container", target: { kind: "reference", key: "tray" } },
              { role: "value", target: { kind: "free", key: "amber_count", excerpt: "amber beads" } }
            ] }] },
            { conditions: [{ kind: "statement", predicate: "count", arguments: [
              { role: "population", target: { kind: "reference", key: "blue" } },
              { role: "container", target: { kind: "reference", key: "tray" } },
              { role: "value", target: { kind: "free", key: "blue_count", excerpt: "blue beads" } }
            ] }] }
          ]
        }]
      }
    }
  }
] as const;
