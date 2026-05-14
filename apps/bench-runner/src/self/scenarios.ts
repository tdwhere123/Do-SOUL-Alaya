export interface SyntheticScenario {
  readonly id: string;
  readonly version: 1;
  readonly category: "preference" | "decision" | "fact" | "feedback" | "project_status";
  /** Utterances to seed as memories before running the probe. */
  readonly setup: ReadonlyArray<string>;
  /** Query issued to soul.recall after seeding. */
  readonly probe: string;
  /** Ids of setup items expected to appear in top-5 recall results (by content index). */
  readonly expected_ids: ReadonlyArray<string>;
}

export const SYNTHETIC_SCENARIOS: ReadonlyArray<SyntheticScenario> = [
  {
    id: "syn-001",
    version: 1,
    category: "preference",
    setup: [
      "I prefer using pnpm over npm for all workspace commands in this monorepo.",
      "Please always use pnpm exec instead of npx when running scripts."
    ],
    probe: "which package manager should I use for workspace commands?",
    expected_ids: ["syn-001-s0", "syn-001-s1"]
  },
  {
    id: "syn-002",
    version: 1,
    category: "preference",
    setup: [
      "All code comments must be anchors, invariants, cross-file refs, or type annotations — never narrative history.",
      "Do not write phase-id or stage-history comments in source files."
    ],
    probe: "what kinds of comments are allowed in source code?",
    expected_ids: ["syn-002-s0", "syn-002-s1"]
  },
  {
    id: "syn-003",
    version: 1,
    category: "decision",
    setup: [
      "We decided to use Zod as the only schema validation library across all packages.",
      "No other runtime schema validation libraries are permitted."
    ],
    probe: "what schema validation library did we choose for the project?",
    expected_ids: ["syn-003-s0", "syn-003-s1"]
  },
  {
    id: "syn-004",
    version: 1,
    category: "decision",
    setup: [
      "The embedding supplement is permanently disabled for the bench harness runs.",
      "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT must be set to false in all bench environments."
    ],
    probe: "is embedding enabled during bench runs?",
    expected_ids: ["syn-004-s0", "syn-004-s1"]
  },
  {
    id: "syn-005",
    version: 1,
    category: "fact",
    setup: [
      "The package namespace for this project is @do-soul/alaya-*.",
      "The consuming agents are Codex, Claude Code, and similar CLI tools."
    ],
    probe: "what is the package namespace for this project?",
    expected_ids: ["syn-005-s0", "syn-005-s1"]
  },
  {
    id: "syn-006",
    version: 1,
    category: "fact",
    setup: [
      "The CLI surface exposes exactly 13 verbs: doctor, install, attach, detach, status, inspect, update, tools list, tools call, backup, export, import, mcp stdio, review.",
      "Any new verb addition requires an invariant update and a major version consideration."
    ],
    probe: "how many CLI verbs does the alaya CLI expose?",
    expected_ids: ["syn-006-s0", "syn-006-s1"]
  },
  {
    id: "syn-007",
    version: 1,
    category: "feedback",
    setup: [
      "The reviewer said: review findings must be fixed in the same release scope, never deferred to a backlog item."
    ],
    probe: "what is the rule about deferring review findings to the backlog?",
    expected_ids: ["syn-007-s0"]
  },
  {
    id: "syn-008",
    version: 1,
    category: "project_status",
    setup: [
      "v0.3.6 is the current release wave; it includes the bench runner and LongMemEval integration."
    ],
    probe: "what does v0.3.6 include?",
    expected_ids: ["syn-008-s0"]
  }
];
