export interface SyntheticScenario {
  readonly id: string;
  readonly version: 1;
  readonly category: "preference" | "decision" | "fact" | "feedback" | "project_status";
  /** Utterances to seed as ground-truth memories before running the probe. */
  readonly setup: ReadonlyArray<string>;
  /**
   * Off-topic memories seeded alongside `setup` to enlarge the recall
   * search space. Distractors are deliberately off-topic so that a hit
   * signal carries information rather than reducing to "the only seed
   * in the workspace is the right one". Distractors are NOT in the
   * expected-hit set; if a distractor is recalled it occupies a top-K
   * slot but does not score.
   */
  readonly distractors: ReadonlyArray<string>;
  readonly probe: string;
  /** Synthetic ids matching the seed order — one id per setup entry. */
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
    distractors: [
      "The weather forecast for Tokyo this weekend is sunny with a chance of rain.",
      "A traditional carbonara recipe uses guanciale, pecorino, eggs, and black pepper.",
      "The Lakers won their last home game by twelve points against the Suns."
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
    distractors: [
      "My favorite hiking trail is the Pacific Crest Trail section through Oregon.",
      "Sourdough fermentation typically takes between four and twelve hours at room temperature.",
      "The local subway station closes for maintenance every third Sunday of the month.",
      "I once attended a jazz festival in New Orleans during the summer of 2018."
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
    distractors: [
      "The book club is meeting next Thursday to discuss a Murakami novel.",
      "Our office coffee machine broke down twice last quarter and needs replacement.",
      "A standard marathon distance is forty-two point one-nine-five kilometres."
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
    distractors: [
      "The neighbour's cat sleeps on our patio every afternoon between two and four.",
      "Annual rainfall in Seattle averages about thirty-eight inches per year.",
      "The bookstore on the corner closes permanently at the end of next month.",
      "She decided to learn classical guitar after watching a flamenco performance."
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
    distractors: [
      "Tuesday's farmers market features stone fruit and heirloom tomatoes this season.",
      "The bridge downtown was completed in nineteen thirty-seven by union crews.",
      "His grandmother taught him to play chess with a hand-carved wooden set."
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
    distractors: [
      "The pottery class on Mondays focuses on wheel-throwing techniques.",
      "Lavender plants prefer well-drained soil and full afternoon sun.",
      "He prefers black coffee in the morning and chamomile tea before bed.",
      "Their dog learned to ring a small bell to ask to go outside."
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
    distractors: [
      "Saturday morning yoga classes start promptly at seven thirty at the community centre.",
      "She traded her old film camera for a new pair of trail running shoes.",
      "The corner cafe serves an excellent cardamom bun on weekends.",
      "Their family rents a cabin every August by a lake in the mountains."
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
    distractors: [
      "The opera season opens with a revival production in mid October.",
      "She finished knitting a scarf using merino wool from a local farm.",
      "Their kitchen renovation finally finished after seven months of delays.",
      "The hardware store on Elm Street stocks a wide selection of brass fittings."
    ],
    probe: "what does v0.3.6 include?",
    expected_ids: ["syn-008-s0"]
  }
];
