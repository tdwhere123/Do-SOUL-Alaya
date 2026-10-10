import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, encodeSourceSemanticQueryCarrier,
  type SourceSemanticQueryMeaningBody } from "@do-soul/alaya-protocol";

export const SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT = "source-semantic-query-response-v8" as const;

const propertyAndTaskExamples = [
  {
    original_query: "What is the color of cabinet C?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        entities: [
          { kind: "named", key: "cabinet", excerpt: "cabinet C" },
          { kind: "free", key: "value", excerpt: "What is the color", return: true }
        ],
        alternatives: [{ conditions: [{
          kind: "statement", predicate: "has color", arguments: [
            { role: "bearer", target: { kind: "reference", key: "cabinet" }, excerpt: "cabinet C" },
            { role: "color", target: { kind: "reference", key: "value" }, excerpt: "What is the color" }
          ]
        }] }]
      }
    }
  },
  {
    original_query: "Please recommend a camera for recording the upcoming rehearsal in hall H.",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "free", key: "camera", excerpt: "a camera", return: true },
          { kind: "named", key: "rehearsal", excerpt: "the upcoming rehearsal" },
          { kind: "named", key: "hall", excerpt: "hall H" }
        ],
        requested_operation: { reading: "Recommend a camera suitable for recording the upcoming rehearsal in hall H.",
          support: { kind: "query_text", excerpt: "recommend a camera for recording the upcoming rehearsal in hall H" } },
        alternatives: [{ conditions: [
          { kind: "statement", predicate: "is suitable for recording", arguments: [
            { role: "instrument", target: { kind: "reference", key: "camera" }, excerpt: "a camera" },
            { role: "recorded event", target: { kind: "reference", key: "rehearsal" }, excerpt: "the upcoming rehearsal" }
          ] },
          { kind: "statement", predicate: "is a camera", arguments: [
            { role: "theme", target: { kind: "reference", key: "camera" }, excerpt: "a camera" }
          ] },
          { kind: "statement", predicate: "is a rehearsal expected to occur after the query time", arguments: [
            { role: "theme", target: { kind: "reference", key: "rehearsal" }, excerpt: "the upcoming rehearsal" }
          ] },
          { kind: "statement", predicate: "has venue", arguments: [
            { role: "event", target: { kind: "reference", key: "rehearsal" }, excerpt: "the upcoming rehearsal" },
            { role: "venue", target: { kind: "reference", key: "hall" }, excerpt: "hall H" }
          ] }
        ] }],
        gaps: [{ kind: "unsupported_meaning", affected_ids: [],
          support: [{ kind: "query_text", excerpt: "Please recommend" }],
          description: "The requested recommendation remains an unexecuted operation; candidate suitability does not perform it." }]
      }
    }
  },
  {
    original_query: "My oak cabinet needs a brighter finish. Any advice?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "named", key: "cabinet", excerpt: "My oak cabinet" },
          { kind: "free", key: "advice", excerpt: "Any advice", return: true }
        ],
        requested_operation: { reading: "Provide advice for a brighter finish on the speaker's oak cabinet.",
          support: { kind: "query_text", excerpt: "Any advice?" } },
        alternatives: [{ conditions: [{ kind: "statement", predicate: "is advice for achieving a brighter finish on", arguments: [
          { role: "advice", target: { kind: "reference", key: "advice" }, excerpt: "Any advice" },
          { role: "object", target: { kind: "reference", key: "cabinet" }, excerpt: "My oak cabinet" }
        ] }] }],
        gaps: [{ kind: "unsupported_meaning", affected_ids: [],
          support: [{ kind: "query_text", excerpt: "Any advice?" }],
          description: "Providing advice remains an unexecuted operation; relevant advice evidence does not perform it." }]
      }
    }
  },
  {
    original_query: "Who asked for advice about a brighter finish on cabinet C?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        entities: [
          { kind: "free", key: "requester", excerpt: "Who", return: true },
          { kind: "named", key: "cabinet", excerpt: "cabinet C" }
        ],
        alternatives: [{ conditions: [{ kind: "statement", predicate: "asked before the query time for advice about a brighter finish on", arguments: [
          { role: "requester", target: { kind: "reference", key: "requester" }, excerpt: "Who" },
          { role: "object", target: { kind: "reference", key: "cabinet" }, excerpt: "cabinet C" }
        ] }] }]
      }
    }
  },
  {
    original_query: "What is the name of the oak cabinet in hall H?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        entities: [
          { kind: "named", key: "cabinet", excerpt: "the oak cabinet in hall H" },
          { kind: "free", key: "value", excerpt: "What is the name", return: true }
        ],
        alternatives: [{ conditions: [{ kind: "statement", predicate: "has name", arguments: [
          { role: "bearer", target: { kind: "reference", key: "cabinet" }, excerpt: "the oak cabinet in hall H" },
          { role: "name", target: { kind: "reference", key: "value" }, excerpt: "What is the name" }
        ] }] }]
      }
    }
  },
  {
    original_query: "How many days a week does Nia attend pottery classes?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "named", key: "nia", excerpt: "Nia" },
          { kind: "free", key: "days", excerpt: "How many days a week", return: true }
        ],
        requested_operation: { reading: "Count distinct pottery-class attendance days per week for Nia.",
          support: { kind: "query_text", excerpt: "How many days a week" } },
        alternatives: [{ conditions: [{ kind: "statement", predicate: "has distinct pottery-class attendance days per week", arguments: [
          { role: "attendee", target: { kind: "reference", key: "nia" }, excerpt: "Nia" },
          { role: "distinct days per week", target: { kind: "reference", key: "days" }, excerpt: "How many days a week" }
        ] }] }],
        gaps: [{ kind: "aggregate", affected_ids: [], support: [{ kind: "query_text", excerpt: "How many days a week" }],
          description: "Counting distinct days remains unexecuted; several classes on one day contribute one attendance day." }]
      }
    }
  },
] as const;

/** Complete neutral producer examples; their admission and incidence are tested. */
const nestedSourceSemanticQueryExamples = [
  {
    original_query: "Who was asked to polish the lens?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "free", key: "person", return: true, excerpt: "Who" },
          { kind: "named", key: "lens", excerpt: "the lens" }
        ],
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["request"],
          support: [{ kind: "query_text", excerpt: "was asked" }],
          description: "The ask event's past tense is not encoded by the retained predicate." }],
        alternatives: [{ conditions: [{
          kind: "statement", key: "request", predicate: "ask",
          arguments: [{ role: "recipient", target: { kind: "reference", key: "person" }, excerpt: "Who" }],
          content: {
            kind: "statement", key: "action", predicate: "polish",
            arguments: [
              { role: "agent", target: { kind: "reference", key: "person" }, excerpt: "Who" },
              { role: "theme", target: { kind: "reference", key: "lens" }, excerpt: "the lens" }
            ]
          }
        }] }]
      }
    }
  },
  {
    original_query: "Is every registered sensor calibrated?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        entities: [
          { kind: "free", key: "sensor", excerpt: "sensor" }
        ],
        domains: [{ key: "sensors", excerpt: "every registered sensor" }],
        evaluation: { kind: "forall", domain: "sensors", binder: "sensor", local_variables: ["sensor", "calibration"] },
        alternatives: [{ conditions: [{
          kind: "statement", key: "calibration", predicate: "calibrated",
          arguments: [{ role: "theme", target: { kind: "reference", key: "sensor" }, excerpt: "sensor" }]
        }] }]
      }
    }
  },
  {
    original_query: "Who has already arrived?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "free", key: "person", return: true, excerpt: "Who" }
        ],
        alternatives: [{ conditions: [{
          kind: "statement", key: "arrival", predicate: "arrive",
          arguments: [{ role: "agent", target: { kind: "reference", key: "person" }, excerpt: "Who" }]
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
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        entities: [
          { kind: "named", key: "amber", excerpt: "amber beads" },
          { kind: "named", key: "blue", excerpt: "blue beads" },
          { kind: "named", key: "tray", excerpt: "tray T" },
          { kind: "free", key: "amber_count", excerpt: "amber beads" },
          { kind: "free", key: "blue_count", excerpt: "blue beads" }
        ],
        requested_operation: { reading: "Compare the amber and blue bead counts in tray T.",
          support: { kind: "query_text", excerpt: "more amber beads than blue beads" } },
        alternatives: [{
          conditions: [{ kind: "statement", predicate: "contain more than", arguments: [
            { role: "greater population", target: { kind: "reference", key: "amber" }, excerpt: "amber beads" },
            { role: "lesser population", target: { kind: "reference", key: "blue" }, excerpt: "blue beads" },
            { role: "container", target: { kind: "reference", key: "tray" }, excerpt: "tray T" },
          ] }],
          evidence_inputs: [
            { conditions: [{ kind: "statement", predicate: "count", arguments: [
              { role: "population", target: { kind: "reference", key: "amber" }, excerpt: "amber beads" },
              { role: "container", target: { kind: "reference", key: "tray" }, excerpt: "tray T" },
              { role: "value", target: { kind: "reference", key: "amber_count" }, excerpt: "amber beads" }
            ] }] },
            { conditions: [{ kind: "statement", predicate: "count", arguments: [
              { role: "population", target: { kind: "reference", key: "blue" }, excerpt: "blue beads" },
              { role: "container", target: { kind: "reference", key: "tray" }, excerpt: "tray T" },
              { role: "value", target: { kind: "reference", key: "blue_count" }, excerpt: "blue beads" }
            ] }] }
          ]
        }]
      }
    }
  },
  {
    original_query: "Did ringing precede flashing?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [],
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
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "named", key: "lens", excerpt: "the lens" }
        ],
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["polish"],
          support: [{ kind: "query_text", excerpt: "question asked whether the lens was polished" }],
          description: "The past question act and past embedded polishing are not encoded by the retained frame." }],
        alternatives: [{ conditions: [{ kind: "statement", key: "polish", predicate: "polish", return: true,
          required_evidence_act: { act: "question", excerpt: "question asked whether" },
          arguments: [{ role: "theme", target: { kind: "reference", key: "lens" }, excerpt: "the lens" }]
        }] }]
      }
    }
  },
  {
    original_query: "Which directive required polishing the lens?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "named", key: "lens", excerpt: "the lens" }
        ],
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["polish"],
          support: [{ kind: "query_text", excerpt: "directive required polishing" }],
          description: "The directive's past requirement is not encoded by the retained frame." }],
        alternatives: [{ conditions: [{ kind: "statement", key: "polish", predicate: "polish", return: true,
          required_evidence_act: { act: "directive", excerpt: "directive required" },
          arguments: [{ role: "theme", target: { kind: "reference", key: "lens" }, excerpt: "the lens" }]
        }] }]
      }
    }
  },
  {
    original_query: "Which tool did the workshop steward use?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "named", key: "steward", excerpt: "the workshop steward" },
          { kind: "free", key: "tool", excerpt: "Which tool", return: true }
        ],
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["use_event"],
          support: [{ kind: "query_text", excerpt: "did the workshop steward use" }],
          description: "The use event's past tense is not encoded by the retained predicate." }],
        alternatives: [{ conditions: [
          { kind: "statement", key: "use_event", predicate: "use", arguments: [
            { role: "agent", target: { kind: "reference", key: "steward" }, excerpt: "the workshop steward" },
            { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "Which tool" }
          ] },
          { kind: "statement", key: "tool_class", predicate: "is a tool", arguments: [
            { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "tool" }
          ] }
        ] }]
      }
    }
  },
  {
    original_query: "Which tool did that technician use?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "named", key: "technician", excerpt: "that technician" },
          { kind: "free", key: "tool", excerpt: "Which tool", return: true }
        ],
        alternatives: [{ conditions: [
          { kind: "statement", key: "use_event", predicate: "use", arguments: [
            { role: "agent", target: { kind: "reference", key: "technician" }, excerpt: "that technician" },
            { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "Which tool" }
          ] },
          { kind: "statement", key: "tool_class", predicate: "is a tool", arguments: [
            { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "tool" }
          ] }
        ] }],
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
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "free", key: "person", excerpt: "someone" },
          { kind: "free", key: "tool", excerpt: "Which tool", return: true }
        ],
        gaps: [{ kind: "unsupported_meaning", affected_ids: ["use_event"],
          support: [{ kind: "query_text", excerpt: "did someone use" }],
          description: "The use event's past tense is not encoded by the retained predicate." }],
        alternatives: [{ conditions: [
          { kind: "statement", key: "use_event", predicate: "use", arguments: [
            { role: "agent", target: { kind: "reference", key: "person" }, excerpt: "someone" },
            { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "Which tool" }
          ] },
          { kind: "statement", key: "tool_class", predicate: "is a tool", arguments: [
            { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "tool" }
          ] }
        ] }]
      }
    }
  },
  {
    original_query: "What is the elapsed time in hours between Tara sealing crate C on 3 March 2024 and Tara opening crate C on 4 March 2024?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
        entities: [
          { kind: "named", key: "tara", excerpt: "Tara" },
          { kind: "named", key: "crate", excerpt: "crate C" },
          { kind: "named", key: "seal_day", excerpt: "3 March 2024" },
          { kind: "named", key: "open_day", excerpt: "4 March 2024" },
          { kind: "free", key: "elapsed_hours", excerpt: "What is the elapsed time in hours", return: true },
          { kind: "free", key: "start_time", excerpt: "Tara sealing crate C on 3 March 2024" },
          { kind: "free", key: "end_time", excerpt: "Tara opening crate C on 4 March 2024" }
        ],
        requested_operation: { reading: "Calculate elapsed hours from the sealing time to the opening time.",
          support: { kind: "query_text", excerpt: "elapsed time in hours between" } },
        alternatives: [{
          conditions: [
            { kind: "statement", key: "elapsed", predicate: "elapsed hours between events", arguments: [
              { role: "start event", target: { kind: "reference", key: "sealing" },
                excerpt: "Tara sealing crate C on 3 March 2024" },
              { role: "end event", target: { kind: "reference", key: "opening" },
                excerpt: "Tara opening crate C on 4 March 2024" },
              { role: "hours", target: { kind: "reference", key: "elapsed_hours" }, excerpt: "What is the elapsed time in hours" }
            ] },
            { kind: "statement", key: "crate_kind", predicate: "is a crate", arguments: [
              { role: "theme", target: { kind: "reference", key: "crate" }, excerpt: "crate C" }
            ] },
            { kind: "statement", key: "sealing", predicate: "seal", arguments: [
              { role: "agent", target: { kind: "reference", key: "tara" }, excerpt: "Tara" },
              { role: "theme", target: { kind: "reference", key: "crate" }, excerpt: "crate C" },
              { role: "date", target: { kind: "reference", key: "seal_day" }, excerpt: "3 March 2024" }
            ] },
            { kind: "statement", key: "opening", predicate: "open", arguments: [
              { role: "agent", target: { kind: "reference", key: "tara" }, excerpt: "Tara" },
              { role: "theme", target: { kind: "reference", key: "crate" }, excerpt: "crate C" },
              { role: "date", target: { kind: "reference", key: "open_day" }, excerpt: "4 March 2024" }
            ] }
          ],
          evidence_inputs: [
            { conditions: [
              { kind: "occurrence", key: "sealing" },
              { kind: "occurrence", key: "crate_kind" },
              { kind: "statement", key: "seal_time", predicate: "time of event", arguments: [
                { role: "event", target: { kind: "reference", key: "sealing" },
                  excerpt: "Tara sealing crate C on 3 March 2024" },
                { role: "time", target: { kind: "reference", key: "start_time" }, excerpt: "Tara sealing crate C on 3 March 2024" }
              ] }
            ] },
            { conditions: [
              { kind: "occurrence", key: "opening" },
              { kind: "occurrence", key: "crate_kind" },
              { kind: "statement", key: "open_time", predicate: "time of event", arguments: [
                { role: "event", target: { kind: "reference", key: "opening" },
                  excerpt: "Tara opening crate C on 4 March 2024" },
                { role: "time", target: { kind: "reference", key: "end_time" }, excerpt: "Tara opening crate C on 4 March 2024" }
              ] }
            ] }
          ]
        }]
      }
    }
  },
  {
    original_query: "How many tools did the clerk borrow or return?",
    response: {
      outcome: { status: "interpreted" },
      query: {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
        entities: [
          { kind: "named", key: "clerk", excerpt: "the clerk" },
          { kind: "free", key: "tool", excerpt: "tools" }
        ],
        requested_operation: { reading: "Count tools across independently contributed borrow or return events.",
          support: { kind: "query_text", excerpt: "How many" } },
        alternatives: [{
          conditions: [],
          evidence_inputs: [
            { conditions: [
              { kind: "statement", key: "borrow", predicate: "borrow", arguments: [
                { role: "agent", target: { kind: "reference", key: "clerk" }, excerpt: "the clerk" },
                { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "tools" }
              ] },
              { kind: "statement", key: "borrow_kind", predicate: "is a tool", arguments: [
                { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "tools" }
              ] }
            ] },
            { conditions: [
              { kind: "statement", key: "return", predicate: "return", arguments: [
                { role: "agent", target: { kind: "reference", key: "clerk" }, excerpt: "the clerk" },
                { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "tools" }
              ] },
              { kind: "statement", key: "return_kind", predicate: "is a tool", arguments: [
                { role: "theme", target: { kind: "reference", key: "tool" }, excerpt: "tools" }
              ] }
            ] }
          ]
        }],
        gaps: [
          { kind: "unsupported_meaning", affected_ids: ["borrow", "return"],
            support: [{ kind: "query_text", excerpt: "did the clerk borrow or return" }],
            description: "The borrow and return events' past tense is not encoded by the retained predicates." },
          { kind: "aggregate", affected_ids: [],
            support: [{ kind: "query_text", excerpt: "How many" }],
            description: "The requested count remains an unexecuted operation." }
        ]
      }
    }
  },
  ...propertyAndTaskExamples
] as const;

export const sourceSemanticQueryExamples: readonly Readonly<{
  original_query: string;
  response: Readonly<{
    contract: typeof SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT;
    outcome: Readonly<{ status: "interpreted" }>;
    query: ReturnType<typeof encodeSourceSemanticQueryCarrier> & Readonly<{
      entities: NonNullable<ReturnType<typeof encodeSourceSemanticQueryCarrier>["entities"]>;
    }>;
  }>;
}>[] = nestedSourceSemanticQueryExamples.map(example => {
  const { contract, entities = [], nodes, ...meaning } = encodeSourceSemanticQueryCarrier(
    example.response.query as SourceSemanticQueryMeaningBody);
  return { ...example, response: {
    ...example.response, contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
    query: { contract, entities, nodes, ...meaning }
  } };
});
