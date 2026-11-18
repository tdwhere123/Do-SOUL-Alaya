import { soulToolDefs } from "@do-soul/alaya-engine-gateway";
import { type AlayaMemoryToolName } from "../../../mcp-memory/tool/tool-catalog.js";

/**
 * Daemon-owned loop suffixes, independent of `loopSuffixByName`.
 * Gateway `soulToolDefs` (SemVer-pinned) remain the base-text authority.
 */
export const EXPECTED_LOOP_SUFFIX_BY_NAME = Object.freeze({
  "soul.recall":
    "Use `result_kind_view: \"memory_only\"` if the consumer cannot parse `source_evidence`. The default `mixed` view supports both result kinds. Selectively continue a relevant ranked result when its `target.span.content_complete === false`. Repeat the request with the returned `index.continuation` and `payload_continuation` {schema_version:1, purpose:\"payload_expansion\", target: its index entry target, start_offset: span.content_end} until `content_complete` is true. Retry the same continuation to replay its `delivery_id`. Use the returned `delivery_id` in soul.report_context_usage.",
  "soul.open_pointer":
    "Use this before citing memory or source content so evidence is grounded in retrieved objects; for `source_target` reads, pass `start_offset` from `target.span.content_end` when `content_complete` is false to read further chunks.",
  "soul.emit_candidate_signal":
    "This records candidate intent only; it does not create or mutate durable memory entries.",
  "soul.propose_memory_update":
    "This creates a pending proposal for governance; durable memory remains unchanged until acceptance apply.",
  "soul.review_memory_proposal":
    "Use only after listing pending proposals and obtaining explicit reviewer approval; accept triggers apply, reject preserves memory as-is.",
  "soul.list_pending_proposals":
    "Review queues represent governance state only; pending items are not durable memory writes.",
  "soul.propose_edge":
    "Pending edge proposals are governance queue items only; durable graph edges are written only after review.",
  "soul.list_pending_edge_proposals":
    "Read-only inspection aid for graph governance; pending items are not durable path relations.",
  "soul.batch_review_edge_proposals":
    "Use only after explicit reviewer approval; accept mints a durable path relation, reject preserves graph state.",
  "soul.apply_override":
    "Session-only correction for the current run; it does not promote durable memory by itself.",
  "soul.explore_graph":
    "Inspection aid for related memories; keep write actions on proposal/candidate tools.",
  "soul.report_context_usage":
    "Close the delivery loop by marking used/skipped/not_applicable so trust state stays explicit.",
  "soul.capture_host_session":
    "Captured messages are source input, not claims of truth; a repeated window admits nothing new.",
  "soul.resolve":
    "Apply a resolution against a staged warning surfaced by soul.recall; the audit event is the durable record of the decision.",
  "soul.interpretation": "",
  "garden.list_pending_tasks": "",
  "garden.claim_task": "",
  "garden.complete_task": ""
}) satisfies Readonly<Record<AlayaMemoryToolName, string>>;

export function expectedEffectiveDescriptionByName(): ReadonlyMap<AlayaMemoryToolName, string> {
  const byName = new Map<AlayaMemoryToolName, string>();
  for (const spec of soulToolDefs) {
    const name = spec.name as AlayaMemoryToolName;
    const suffix = EXPECTED_LOOP_SUFFIX_BY_NAME[name].trim();
    byName.set(name, suffix.length === 0 ? spec.description : `${spec.description} ${suffix}`);
  }
  return byName;
}
