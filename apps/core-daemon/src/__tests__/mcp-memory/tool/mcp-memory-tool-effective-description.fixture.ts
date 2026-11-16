import { soulToolDefs } from "@do-soul/alaya-engine-gateway";
import { type AlayaMemoryToolName } from "../../../mcp-memory/tool/tool-catalog.js";

/**
 * Daemon-owned loop suffixes, independent of `loopSuffixByName`.
 * Gateway `soulToolDefs` (SemVer-pinned) remain the base-text authority.
 */
export const EXPECTED_LOOP_SUFFIX_BY_NAME = Object.freeze({
  "soul.recall":
    "Optional `enumeration_policy` (`native_query` default and the only value live execution accepts; `canonical` and `associative` stay parseable for historical readers but are rejected), `result_kind_view` (`mixed` default, or `memory_only`/`source_only`), `interpretation_proposal`, and `payload_continuation` are request identity/view fields. A source result with `target.span.content_complete=false` was cut at a page boundary: continue it before answering by repeating the request with the returned `index.continuation` and `payload_continuation` {schema_version:1, purpose:\"payload_expansion\", target: its index entry target, start_offset: span.content_end} until `content_complete` is true. For question-time preference, send a proposal with schema_version=1, producer_id=alaya.query.question-time.v1, producer_version=1, original_query_digest=sha256 of the exact UTF-8 query, and question_time={interpretation_clock: the same source_observed_at clock, intervals:[{start:YYYY-MM-DD,end:YYYY-MM-DD}]}. Form at most 32 closed UTC calendar-day alternatives from the question and clock only, never from sources or answers. This producer accepts only question_time, not programs or conditions. The window is a soft preference on source event_time under the existing root/attempt limits; since/until remain hard filters. Omit it when no window is formed. `associative` also requires declared `cap_contracts`; absence is incompatible (parse error), not a default. Results carry a tagged `target`; source-record-only rows use `object_kind` `source_evidence` and do not mint a memory id. Responses may include `page_purpose` and `product_updates`; retrying the same continuation replays the same `delivery_id`. Older consumers that cannot parse source targets must request `result_kind_view=memory_only` rather than dropping or recasting source rows. Start memory-sensitive turns here; use the returned delivery_id later in soul.report_context_usage. Mixed or source_only views require protocol_version=1 and source_evidence support; undeclared mixed is a compatibility error rather than a later parse failure.",
  "soul.open_pointer":
    "Use this before citing memory content so evidence is grounded in retrieved objects.",
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
