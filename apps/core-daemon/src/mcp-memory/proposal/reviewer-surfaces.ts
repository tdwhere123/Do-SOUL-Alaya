// The daemon HTTP reviewer surface asserts reviewer_identity over the network
// with no token, so it must carry a configured reviewer binding to be trusted;
// `cli` is a local human at a terminal who legitimately names themselves.
export const HTTP_REVIEWER_AGENT_TARGET = "http-reviewer";

export const HUMAN_REVIEWER_AGENT_TARGETS: ReadonlySet<string> = new Set([
  HTTP_REVIEWER_AGENT_TARGET,
  "cli"
]);

// Apply/reject stays off attached MCP; listing these names would invite self-review.
export const HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES = Object.freeze([
  "soul.review_memory_proposal",
  "soul.batch_review_edge_proposals"
] as const);

export const HOST_INTERPRETATION_AGENT_TARGET = "host-interpretation";

// Host/operator surfaces advertise the host-owned interpretation catalog;
// ordinary attached consumer sessions omit it from tools/list while keeping dispatch.
export const HOST_INTERPRETATION_CATALOG_AGENT_TARGETS: ReadonlySet<string> = new Set([
  HTTP_REVIEWER_AGENT_TARGET,
  "cli",
  HOST_INTERPRETATION_AGENT_TARGET
]);
