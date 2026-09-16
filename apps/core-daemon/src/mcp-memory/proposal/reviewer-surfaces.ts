// The Inspector HTTP loopback asserts reviewer_identity over the network with
// no token, so it must carry a configured reviewer binding to be trusted;
// `cli` is a local human at a terminal who legitimately names themselves.
export const INSPECTOR_REVIEWER_AGENT_TARGET = "inspector";

export const HUMAN_REVIEWER_AGENT_TARGETS: ReadonlySet<string> = new Set([
  INSPECTOR_REVIEWER_AGENT_TARGET,
  "cli"
]);

// Apply/reject stays off attached MCP; listing these names would invite self-review.
export const HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES = Object.freeze([
  "soul.review_memory_proposal",
  "soul.batch_review_edge_proposals"
] as const);
