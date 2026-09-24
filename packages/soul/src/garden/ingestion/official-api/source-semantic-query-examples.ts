import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT } from "@do-soul/alaya-protocol";

/** Complete neutral producer examples; their admission and incidence are tested. */
export const sourceSemanticQueryExamples = [
  {
    original_query: "Who was asked to polish the lens?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["request"],
          support: [{ kind: "query_text", excerpt: "was asked" }],
          description: "The ask event's past tense is not encoded by the retained predicate." }],
        alternatives: [{ conditions: [{
          kind: "statement", key: "request", predicate: "ask",
          arguments: [{ role: "recipient", target: { kind: "free", key: "person", return: true }, excerpt: "Who" }],
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
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
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
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        alternatives: [{ conditions: [{
          kind: "statement", key: "arrival", predicate: "arrive",
          arguments: [{ role: "agent", target: { kind: "free", key: "person", return: true }, excerpt: "Who" }]
        }] }],
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["arrival"],
          support: [{ kind: "query_text", excerpt: "has already arrived" }],
          description: "The retained arrival predicate does not encode the requested present-perfect completion qualification." }]
      }
    }
  },
  {
    original_query: "Does tray T contain more amber beads than blue beads?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        requested_operation: { reading: "Compare the amber and blue bead counts in tray T.",
          support: { kind: "query_text", excerpt: "more amber beads than blue beads" } },
        entities: [
          { kind: "named", key: "amber", excerpt: "amber beads" },
          { kind: "named", key: "blue", excerpt: "blue beads" },
          { kind: "named", key: "tray", excerpt: "tray T" }
        ],
        alternatives: [{
          conditions: [{ kind: "statement", predicate: "contain more than", arguments: [
            { role: "greater population", target: { kind: "reference", key: "amber" } },
            { role: "lesser population", target: { kind: "reference", key: "blue" } },
            { role: "container", target: { kind: "reference", key: "tray" } },
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
  },
  {
    original_query: "Did ringing precede flashing?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["before", "ring", "flash"],
          support: [{ kind: "query_text", excerpt: "Did ringing precede flashing" }],
          description: "The requested past occurrence is not encoded by the retained event predicates." }],
        alternatives: [{ conditions: [
          { kind: "statement", key: "before", predicate: "precede", arguments: [
            { role: "earlier", target: { kind: "reference", key: "ring" }, excerpt: "ringing" },
            { role: "later", target: { kind: "reference", key: "flash" }, excerpt: "flashing" }
          ] },
          { kind: "statement", key: "ring", predicate: "ring", arguments: [] },
          { kind: "statement", key: "flash", predicate: "flash", arguments: [] }
        ] }]
      }
    }
  },
  {
    original_query: "Which question asked whether the lens was polished?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["polish"],
          support: [{ kind: "query_text", excerpt: "question asked whether the lens was polished" }],
          description: "The past question act and past embedded polishing are not encoded by the retained frame." }],
        alternatives: [{ conditions: [{ kind: "statement", key: "polish", predicate: "polish", return: true,
          required_evidence_act: { act: "question", excerpt: "question asked whether" },
          arguments: [{ role: "theme", target: { kind: "named", key: "lens", excerpt: "the lens" } }]
        }] }]
      }
    }
  },
  {
    original_query: "Which directive required polishing the lens?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["polish"],
          support: [{ kind: "query_text", excerpt: "directive required polishing" }],
          description: "The directive's past requirement is not encoded by the retained frame." }],
        alternatives: [{ conditions: [{ kind: "statement", key: "polish", predicate: "polish", return: true,
          required_evidence_act: { act: "directive", excerpt: "directive required" },
          arguments: [{ role: "theme", target: { kind: "named", key: "lens", excerpt: "the lens" } }]
        }] }]
      }
    }
  },
  {
    original_query: "Which tool did the workshop steward use?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["use_event"],
          support: [{ kind: "query_text", excerpt: "did the workshop steward use" }],
          description: "The use event's past tense is not encoded by the retained predicate." }],
        alternatives: [{ conditions: [{ kind: "statement", key: "use_event", predicate: "use", arguments: [
          { role: "agent", target: { kind: "named", key: "steward", excerpt: "the workshop steward" } },
          { role: "theme", target: { kind: "free", key: "tool", excerpt: "Which tool", return: true } }
        ] }] }]
      }
    }
  },
  {
    original_query: "Which tool did that technician use?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        alternatives: [{ conditions: [{ kind: "statement", key: "use_event", predicate: "use", arguments: [
          { role: "agent", target: { kind: "named", key: "technician", excerpt: "that technician" } },
          { role: "theme", target: { kind: "free", key: "tool", excerpt: "Which tool", return: true } }
        ] }] }],
        gaps: [
          { kind: "unresolved_referent", affected_ids: ["technician"],
            support: [{ kind: "query_text", excerpt: "that technician" }],
            description: "The supplied question and context do not identify which technician is meant." },
          { kind: "unsupported_meaning", affected_ids: ["use_event"],
            support: [{ kind: "query_text", excerpt: "did that technician use" }],
            description: "The use event's past tense is not encoded by the retained predicate." }
        ]
      }
    }
  },
  {
    original_query: "Which tool did someone use?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["use_event"],
          support: [{ kind: "query_text", excerpt: "did someone use" }],
          description: "The use event's past tense is not encoded by the retained predicate." }],
        alternatives: [{ conditions: [{ kind: "statement", key: "use_event", predicate: "use", arguments: [
          { role: "agent", target: { kind: "free", key: "person", excerpt: "someone" } },
          { role: "theme", target: { kind: "free", key: "tool", excerpt: "Which tool", return: true } }
        ] }] }]
      }
    }
  },
  {
    original_query: "What is the elapsed time in hours between Tara sealing crate C on 3 March 2024 and Tara opening crate C on 4 March 2024?",
    response: {
      contract: "source-semantic-query-response-v7", outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        requested_operation: { reading: "Calculate elapsed hours from the sealing time to the opening time.",
          support: { kind: "query_text", excerpt: "elapsed time in hours between" } },
        entities: [
          { kind: "named", key: "tara", excerpt: "Tara" },
          { kind: "named", key: "crate", excerpt: "crate C" },
          { kind: "named", key: "seal_day", excerpt: "3 March 2024" },
          { kind: "named", key: "open_day", excerpt: "4 March 2024" }
        ],
        alternatives: [{
          conditions: [
            { kind: "statement", key: "elapsed", predicate: "elapsed hours between events", arguments: [
              { role: "start event", target: { kind: "reference", key: "sealing" },
                excerpt: "Tara sealing crate C on 3 March 2024" },
              { role: "end event", target: { kind: "reference", key: "opening" },
                excerpt: "Tara opening crate C on 4 March 2024" },
              { role: "hours", target: { kind: "free", key: "elapsed_hours", excerpt: "What is the elapsed time in hours", return: true } }
            ] },
            { kind: "statement", key: "sealing", predicate: "seal", arguments: [
              { role: "agent", target: { kind: "reference", key: "tara" } },
              { role: "theme", target: { kind: "reference", key: "crate" } },
              { role: "date", target: { kind: "reference", key: "seal_day" } }
            ] },
            { kind: "statement", key: "opening", predicate: "open", arguments: [
              { role: "agent", target: { kind: "reference", key: "tara" } },
              { role: "theme", target: { kind: "reference", key: "crate" } },
              { role: "date", target: { kind: "reference", key: "open_day" } }
            ] }
          ],
          evidence_inputs: [
            { conditions: [
              { kind: "occurrence", key: "sealing" },
              { kind: "statement", key: "seal_time", predicate: "time of event", arguments: [
                { role: "event", target: { kind: "reference", key: "sealing" },
                  excerpt: "Tara sealing crate C on 3 March 2024" },
                { role: "time", target: { kind: "free", key: "start_time", excerpt: "Tara sealing crate C on 3 March 2024" } }
              ] }
            ] },
            { conditions: [
              { kind: "occurrence", key: "opening" },
              { kind: "statement", key: "open_time", predicate: "time of event", arguments: [
                { role: "event", target: { kind: "reference", key: "opening" },
                  excerpt: "Tara opening crate C on 4 March 2024" },
                { role: "time", target: { kind: "free", key: "end_time", excerpt: "Tara opening crate C on 4 March 2024" } }
              ] }
            ] }
          ]
        }]
      }
    }
  }
] as const;
