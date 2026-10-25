import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { authorizedScopesFromAdmission } from "@do-soul/alaya-core";
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { AlayaError, SoulMemorySearchRequestSchema, SoulMemorySearchResponseSchema,
  canonicalJson, canonicalIndexEntryIdentity, sameRecallTarget, indexEntryObjectKind, sourceEvidenceRootTarget,
  type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { readBenchMcpToolOutput } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { exposureSlots, type FirstExposurePage } from "../../measurement/first-exposure-session.js";
import { admittedSourceDeliveryTail } from "../../measurement/source-delivery-visibility.js";
import type { ConsumerVisibilityPage } from "../../longmemeval-semantic/message-visibility.js";
import { SemanticChainConfigSchema, chainIdentity, readChainArtifact } from "../contract.js";
import { assertSemanticChainSourceIndex } from "../source-index-binding.js";
import { hashRegularFileNoFollow } from "../../snapshot/bound-file.js";
import { OrdinaryRecallExecutionSchema, mapOrdinaryRecallScope, buildOrdinaryRecallRequest,
  type OrdinaryRecallQueryRow } from "./ordinary-entry-contract.js";
import { admitOrdinaryEntryCursor } from "./ordinary-entry-execution.js";
import { verifyExposure } from "./ordinary-recall-delivery.js";
import { admitOrdinarySourceDelivery, admitOrdinarySourceResults } from "./ordinary-source-admission.js";
import { ordinaryLiteralWindows, ordinaryUnmappedSources, type OrdinarySourcePreview } from "./ordinary-preview-stream.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new AlayaError("CONFLICT", message);
}

/** Label-independent ordinary replay. Historical private archives retain their old
 * helper bytes; current evaluation delegates here rather than redefining wire/byte admission. */
export function admitOrdinaryFrozenExecution(input: Readonly<{
  executionRoot: string; config: unknown; query: { query_key: string; original_query: string };
}>) {
  const config = SemanticChainConfigSchema.parse(input.config);
  // Replay binds producer bytes, not a new query under the evaluator's revision.
  // Runtime/helper identities are separately bound by the enclosing evaluation entry.
  check(hashRegularFileNoFollow(config.snapshot_path) === config.snapshot_sha256, "ordinary replay snapshot changed");
  if (config.source_index !== undefined) assertSemanticChainSourceIndex(config);
  const raw = readChainArtifact(join(input.executionRoot, "ordinary/ordinary-entry.json"));
  const execution = OrdinaryRecallExecutionSchema.parse(raw);
  check(equal(execution, raw), "ordinary archive cannot be normalized");
  check(execution.config_identity === chainIdentity(config) && execution.rows.length === 1
    && execution.rows[0]!.query_key === input.query.query_key
    && execution.rows[0]!.original_query === input.query.original_query, "ordinary archive/config/query binding mismatch");
  const row = execution.rows[0]!;
  check(row.status !== "failed" && row.pages.every(page => !["transport_error", "public_error", "invalid_response"].includes(page.response_state)),
    "ordinary capture failed");
  check(row.page_count === row.pages.length, "ordinary page count projection mismatch");
  const scope = mapOrdinaryRecallScope(config.authorized_scopes);
  check(scope.status === "mapped" || row.pages.length === 0, "ordinary request scope is not mapped");
  const firstRequest = scope.status === "mapped" ? buildOrdinaryRecallRequest({ query: row.original_query,
    scope_class: scope.scope_class, source_observed_at: config.interpretation_clock }) : null;
  const database = openReadOnlyDatabase(config.snapshot_path);
  try {
    const scopes = authorizedScopesFromAdmission(config.authorized_scopes).authorized_scopes;
    check(scopes !== undefined, "ordinary source principal unbound");
    const pages: ConsumerVisibilityPage[] = [], previews: OrdinarySourcePreview[] = [];
    const rowIntervals: OrdinaryRecallQueryRow["source_intervals"] = [];
    const seen = { deliveries: new Set<string>(), continuations: new Set<string>(), positions: new Set<string>() };
    let occupied = 0, first: FirstExposurePage | null = null;
    let identity: OrdinaryRecallQueryRow["snapshot_identity"] = null, previous: OrdinaryRecallQueryRow["pages"][number] | null = null;
    for (const [position, page] of row.pages.entries()) {
      check(page.ordinal === position + 1 && (previous === null || previous.observation === "observed"), "ordinary page sequence mismatch");
      const request = position === 0 ? firstRequest : SoulMemorySearchRequestSchema.parse({ ...firstRequest,
        continuation: previous?.output?.index?.continuation });
      check(position === 0 || previous?.output?.index?.continuation != null, "ordinary continuation was not issued");
      check(equal(page.request, request), "ordinary request differs from frozen query/continuation");
      const output = admitRawOutput(page), index = output?.index;
      // Every returned source is admitted even if exposure metadata is unavailable.
      const admitted = output === null ? [] : admitOrdinarySourceResults(database, config.workspace_id, scopes, output.results, occupied);
      if (output?.index !== undefined) {
        for (const entry of output.index.entries) if (entry.target.kind === "source_evidence") {
          admitOrdinarySourceDelivery(database, config.workspace_id, scopes, entry.target);
        }
        admitResultMembership(output);
      }
      check(index?.as_of === undefined || index.as_of === config.interpretation_clock, "ordinary raw envelope/clock mismatch");
      const observed = page.observation === "observed";
      if (observed || page.first_exposure !== null) {
        check(index?.interpretation_id !== undefined && index.as_of !== undefined, "ordinary raw envelope/clock mismatch");
        verifyExposure({ request: { arguments: page.request }, output, firstExposure: page.first_exposure }, index, first);
      }
      const projected = admitPageProjection(page, output);
      if (!observed) {
        pages.push({ page: page.ordinal, status: "unobserved", reason: page.response_state, complete: false,
          occupied_slots: 0, continuation: "unknown", terminal_tail: { status: "unknown", reason: page.response_state }, intervals: [] });
      } else {
        check(output !== null && index?.interpretation_id !== undefined && index.as_of !== undefined, "ordinary observed index unavailable");
        const replay = admitOrdinaryEntryCursor(seen, { delivery_id: output.delivery_id,
          request_continuation: page.request.continuation ?? null, issued_continuation: index.continuation,
          positions: output.results.map(result => canonicalJson(result.target.kind === "source_evidence"
            ? sourceEvidenceRootTarget(result.target) : result.target)) });
        check(replay === null, `ordinary observed page replay: ${replay}`);
        const next = { query_id: index.query_id, snapshot_id: index.snapshot_id, result_version: index.result_version,
          interpretation_id: index.interpretation_id, as_of: index.as_of };
        check(identity === null || equal(identity, next), "ordinary query/snapshot identity changed");
        identity ??= next; first ??= page.first_exposure;
        previews.push(...admitted);
        rowIntervals.push(...projected.intervals.map(interval => ({ ...interval, slot_index: occupied + interval.slot_index })));
        pages.push({ page: page.ordinal, status: "observed", reason: null, occupied_slots: projected.slots,
          complete: true, continuation: index.continuation == null ? "none" : "present", terminal_tail: projected.tail,
          intervals: ordinaryLiteralWindows(admitted).map(({ text: _text, ...interval }) => interval),
          unmapped_sources: ordinaryUnmappedSources(admitted) });
        occupied += projected.slots;
      }
      previous = page;
    }
    check(equal(row.first_exposure, first), "ordinary row first-exposure projection mismatch");
    check(equal(row.snapshot_identity, identity), "ordinary row snapshot projection mismatch");
    check(equal(row.source_intervals, rowIntervals), "ordinary row source interval projection mismatch");
    return { pages, previews, windows: ordinaryLiteralWindows(previews) };
  } finally {
    database.close();
    check(hashRegularFileNoFollow(config.snapshot_path) === config.snapshot_sha256, "ordinary replay snapshot changed");
  }
}

function admitPageProjection(page: OrdinaryRecallQueryRow["pages"][number], output: SoulMemorySearchResponse | null) {
  const observed = page.observation === "observed";
  check(!observed || output?.index !== undefined, "ordinary observed index unavailable");
  const slots = observed ? exposureSlots(output!).length : 0;
  const intervals = observed ? output!.results.flatMap((result, slot_index) => result.target.kind === "source_evidence"
    && result.target.span !== undefined ? [{ slot_index, target: result.target, span: result.target.span }] : []) : [];
  check(equal(page.source_intervals, intervals), "ordinary source interval projection mismatch");
  check(page.occupied_slots === slots, "ordinary occupied slot projection mismatch");
  const tail = observed ? admittedSourceDeliveryTail(output!.index!) : page.terminal_tail;
  check(page.complete === observed && page.continuation === (observed ? output!.index!.continuation == null ? "none" : "present" : "unknown")
    && equal(page.terminal_tail, tail) && (observed || page.terminal_tail.status === "unknown"), "ordinary delivery state projection mismatch");
  return { slots, intervals, tail };
}
function admitRawOutput(page: OrdinaryRecallQueryRow["pages"][number]): SoulMemorySearchResponse | null {
  if (page.public_call === null) {
    check(page.output === null && page.envelope === null && page.first_exposure === null
      && page.observation === "unobserved" && page.response_state === "unknown", "ordinary output has no raw MCP call");
    return null;
  }
  check(equal(page.public_call.request, { name: "soul.recall", arguments: page.request }), "ordinary raw request mismatch");
  check(equal(page.public_call.response, page.envelope), "ordinary raw envelope/clock mismatch");
  const generic = readBenchMcpToolOutput("soul.recall", page.public_call.response);
  const output = SoulMemorySearchResponseSchema.parse(generic);
  check(equal(output, generic), "ordinary raw output cannot be normalized");
  check(equal(page.output, output), "ordinary decoded output differs from raw MCP output");
  check(page.response_state === "success", "ordinary response state differs from raw MCP output");
  return output;
}
function admitResultMembership(output: SoulMemorySearchResponse): void {
  const entries = output.index!.entries;
  let previous = -1;
  for (const result of output.results) {
    const { hypothesis_id, output_binding } = result;
    check(hypothesis_id !== undefined && output_binding !== undefined, "ordinary result is not an index member");
    // Adapt only the public product coordinates; Protocol owns their identity/defaults.
    const position = entries.findIndex(entry => canonicalIndexEntryIdentity(entry) === canonicalIndexEntryIdentity({ ...entry,
      target: result.target, interpretation_node: undefined, hypothesis_id, output_binding,
      program_state: result.program_state, time_state: result.time_state }));
    check(position !== -1, "ordinary result is not an index member");
    check(position > previous, "ordinary result order differs from index");
    const entry = output.index!.entries[position]!;
    check(sameRecallTarget(entry.target, result.target), "ordinary index/result target mismatch");
    check(indexEntryObjectKind(entry) === result.object_kind, "ordinary index/result kind mismatch");
    previous = position;
  }
}
