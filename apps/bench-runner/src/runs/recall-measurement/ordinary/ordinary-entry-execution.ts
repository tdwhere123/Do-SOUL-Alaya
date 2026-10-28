import { join } from "node:path";
import { z } from "zod";
import {
  AlayaError, canonicalJson, SoulMemorySearchRequestSchema, SoulMemorySearchResponseSchema,
  type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import { currentBenchScope, refuseBenchWorkAfterCancel, trackBenchOperation } from "../../../harness/daemon-task.js";
import { callMcpTool, readBenchMcpToolOutput, type BenchMcpToolCapture } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import type { BenchDaemonHandle } from "../../../harness/daemon.js";
import { canonicalPath, canonicalPathsOverlap } from "../../fs/opened-contained-path.js";
import { withSnapshotPublishLock } from "../../snapshot/freeze/publish-lock.js";
import {
  FirstExposureSession, firstExposureMismatch, exposureSlots, type FirstExposurePage
} from "../../measurement/first-exposure-session.js";
import {
  SemanticChainConfigSchema, assertChainSnapshot, withSemanticChainDaemon, writeChainArtifact, readChainArtifact,
  chainIdentity, type SemanticChainConfig
} from "../contract.js";
import { semanticChainCacheInputPaths } from "../inputs.js";
import { OrdinaryRecallEnvelopeSchema, OrdinaryRecallRequestRecordSchema, type OrdinaryRecallEnvelope } from "./ordinary-recall-contract.js";
import type { CapturedOrdinaryRecallCall } from "./ordinary-recall.js";
import { verifyExposure } from "./ordinary-recall-delivery.js";
import { admitOrdinaryEntryCursor, ordinaryEntryStopCause, type OrdinaryEntryCursorSeen } from "./ordinary-entry-policy.js";
import { admittedSourceDeliveryTail } from "../../measurement/source-delivery-visibility.js";
import { observeOrdinaryEntry, type CaptureOrdinaryEntryObservation } from "./ordinary-entry-observation.js";
import {
  OrdinaryRecallEntryInputSchema, OrdinaryRecallExecutionSchema, OrdinaryRecallQueryRowSchema,
  OrdinaryRecallSourceIntervalSchema, ORDINARY_RECALL_ENTRY_CONTRACT, ORDINARY_RECALL_OBSERVED_SLOT_TARGET,
  ORDINARY_RECALL_PUBLIC_PAGE_LIMIT, ORDINARY_RECALL_PUBLIC_PAGE_SLOTS, ORDINARY_RECALL_UNMAPPED_DIMENSIONS,
  UNOBSERVED_ORDINARY_COUNTERS, buildOrdinaryRecallRequest, mapOrdinaryRecallScope,
  type OrdinaryRecallExecution, type OrdinaryRecallMapping, type OrdinaryRecallPublicRequest,
  type OrdinaryRecallQueryRow
} from "./ordinary-entry-contract.js";

type SourceInterval = z.infer<typeof OrdinaryRecallSourceIntervalSchema>;
type SnapshotIdentity = NonNullable<OrdinaryRecallQueryRow["snapshot_identity"]>;
type EntryPage = OrdinaryRecallQueryRow["pages"][number];

/**
 * Callable public `soul.recall` launcher (not a CLI, scorer, or gold join).
 * `executeOrdinaryRecallEntry({ config, root, queries })` parses `SemanticChainConfig` and
 * `{ query_key, original_query }[]`, restores the snapshot with `withSemanticChainDaemon`,
 * and calls `callMcpTool(daemon.mcpClient, "soul.recall", args, capture)`.
 * Writes `root/ordinary-entry.json`. Follows issued public continuation until ten occupied
 * slots or admitted occupancy-tail exhaustion. Each observed page sets `occupied_slots` from
 * admitted `exposureSlots`, not `source_intervals.length` (0 when the page is not admitted).
 */
export async function executeOrdinaryRecallEntry(value: unknown, capture?: CaptureOrdinaryEntryObservation): Promise<OrdinaryRecallExecution> {
  const input = OrdinaryRecallEntryInputSchema.parse(value);
  const config = SemanticChainConfigSchema.parse(structuredClone(input.config));
  assertChainSnapshot(config);
  const scope = currentBenchScope();
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    assertOrdinaryEntryOutputRoot(input.root, config);
    const output = join(input.root, "ordinary-entry.json");
    return withSnapshotPublishLock(output, async () => {
      const mapped = mapConfig(config);
      const identity = chainIdentity({
        contract: ORDINARY_RECALL_ENTRY_CONTRACT, config, mapping: mapped, queries: input.queries
      });
      const retained = readChainArtifact(output);
      if (retained !== undefined) {
        if (capture !== undefined) throw new AlayaError("CONFLICT", "observation requires a fresh ordinary entry root");
        const parsed = OrdinaryRecallExecutionSchema.parse(retained);
        if (parsed.input_identity !== identity) {
          throw new AlayaError("CONFLICT", "ordinary entry artifact does not bind the requested config and queries");
        }
        return parsed;
      }
      const execution = freezeOrdinaryArtifact(OrdinaryRecallExecutionSchema, mapped.status === "not_run"
        ? notRunExecution(config, mapped, identity, input.queries)
        : await runMappedOrdinaryRecall(config, input.root, input.queries, mapped, identity, capture));
      refuseBenchWorkAfterCancel();
      writeChainArtifact(output, execution);
      return execution;
    });
  };
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

function mapConfig(config: SemanticChainConfig): OrdinaryRecallMapping {
  const scope = mapOrdinaryRecallScope(config.authorized_scopes);
  const unmapped_dimensions = [...ORDINARY_RECALL_UNMAPPED_DIMENSIONS];
  if (scope.status === "not_run") return { status: "not_run", reason: scope.reason, unmapped_dimensions };
  return {
    status: "mapped", scope_class: scope.scope_class,
    max_results: ORDINARY_RECALL_PUBLIC_PAGE_SLOTS,
    observed_slot_target: ORDINARY_RECALL_OBSERVED_SLOT_TARGET, unmapped_dimensions
  };
}

function notRunExecution(
  config: SemanticChainConfig, mapping: OrdinaryRecallMapping, identity: string,
  queries: readonly { query_key: string; original_query: string }[]
): OrdinaryRecallExecution {
  return {
    contract: ORDINARY_RECALL_ENTRY_CONTRACT, input_identity: identity, config_identity: chainIdentity(config), mapping,
    consumer_model_calls: 0,
    rows: queries.map(query => emptyRow(query, "not_run",
      mapping.status === "not_run" ? mapping.reason : "ordinary entry was not mapped"))
  };
}

async function runMappedOrdinaryRecall(
  config: SemanticChainConfig, root: string,
  queries: readonly { query_key: string; original_query: string }[],
  mapping: Extract<OrdinaryRecallMapping, { status: "mapped" }>, identity: string,
  capture?: CaptureOrdinaryEntryObservation
): Promise<OrdinaryRecallExecution> {
  const rows: OrdinaryRecallQueryRow[] = [];
  await withSemanticChainDaemon(config, root, async daemon => {
    for (const query of queries) {
      refuseBenchWorkAfterCancel();
      const rowPath = join(root, "ordinary-entry", `${query.query_key}.json`);
      const reservation = `${rowPath}.reserved`;
      const prior = readChainArtifact(rowPath);
      const reserved = readChainArtifact(reservation);
      if (prior !== undefined) {
        if (capture !== undefined) throw new AlayaError("CONFLICT", "observation cannot recover an already captured ordinary row");
        if (canonicalJson(reserved) !== canonicalJson({ entry_identity: identity, query_key: query.query_key })) {
          throw new AlayaError("CONFLICT", "ordinary public row does not bind its requested entry identity");
        }
        rows.push(OrdinaryRecallQueryRowSchema.parse(prior)); continue;
      }
      if (reserved !== undefined) {
        throw new AlayaError("CONFLICT", "ordinary public first exposure is unresolved after interruption; retained reservation forbids re-exposure");
      }
      writeChainArtifact(reservation, { entry_identity: identity, query_key: query.query_key });
      const row = await observeOrdinaryEntry(daemon, query.query_key, () => executeOrdinaryQuery(daemon, config, mapping, query), capture);
      const frozen = freezeOrdinaryArtifact(OrdinaryRecallQueryRowSchema, row);
      writeChainArtifact(rowPath, frozen);
      rows.push(frozen);
    }
  }, capture === undefined ? {} : { sourceSemanticObservations: true });
  return {
    contract: ORDINARY_RECALL_ENTRY_CONTRACT, input_identity: identity, config_identity: chainIdentity(config), mapping,
    consumer_model_calls: 0, rows
  };
}

async function executeOrdinaryQuery(
  daemon: BenchDaemonHandle, config: SemanticChainConfig,
  mapping: Extract<OrdinaryRecallMapping, { status: "mapped" }>,
  query: { query_key: string; original_query: string; interpretation_proposal?: OrdinaryRecallPublicRequest["interpretation_proposal"] }
): Promise<OrdinaryRecallQueryRow> {
  const firstRequest = buildOrdinaryRecallRequest({
    query: query.original_query, scope_class: mapping.scope_class, source_observed_at: config.interpretation_clock,
    ...(query.interpretation_proposal === undefined ? {} : { interpretation_proposal: query.interpretation_proposal })
  });
  // Session refuses a replacement initial; replayed cursors/positions fail closed below.
  const session = new FirstExposureSession();
  const cursor: OrdinaryEntryCursorSeen = { deliveries: new Set(), continuations: new Set(), positions: new Set() };
  const pages: EntryPage[] = [];
  let identity: SnapshotIdentity | null = null;
  let firstExposure: FirstExposurePage | null = null;
  let request: OrdinaryRecallPublicRequest = firstRequest;
  let occupied = 0;
  let elapsedMs = 0;
  let elapsedCalls = 0;
  let stopCause: OrdinaryRecallQueryRow["stop_cause"] = "membership_page_bound";
  try {
    for (let ordinal = 1; ordinal <= ORDINARY_RECALL_PUBLIC_PAGE_LIMIT; ordinal += 1) {
      refuseBenchWorkAfterCancel();
      const started = performance.now();
      const page = await recallPublicMembershipPage(daemon, request, ordinal, session, firstExposure);
      elapsedMs += performance.now() - started;
      elapsedCalls += 1;
      pages.push(page);
      if (page.observation !== "observed" || page.output?.index === undefined) {
        stopCause = page.response_state === "public_error" || page.response_state === "invalid_response" ? "failed" : "unavailable";
        break;
      }
      const index = page.output.index;
      const nextIdentity = snapshotIdentity(index, config.interpretation_clock);
      if (identity === null) identity = nextIdentity;
      else if (canonicalJson(identity) !== canonicalJson(nextIdentity)) {
        throw new AlayaError("CONFLICT", "ordinary public query or snapshot identity changed");
      }
      firstExposure ??= page.first_exposure;
      const replayed = refuseReplayedOrdinaryPage(page, request, cursor);
      if (replayed !== null) {
        pages[pages.length - 1] = replayed;
        stopCause = "unavailable";
        break;
      }
      occupied += page.occupied_slots;
      const stopped = ordinaryEntryStopCause(index, occupied, ordinal);
      if (stopped !== null) { stopCause = stopped; break; }
      request = SoulMemorySearchRequestSchema.parse({ ...firstRequest, continuation: index.continuation });
    }
  } catch (error) {
    refuseBenchWorkAfterCancel();
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    return finishQuery(query, pages, identity, firstExposure, ordinaryCosts(elapsedCalls, elapsedMs), "unavailable",
      "unavailable", error instanceof Error ? error.message : String(error));
  }
  return finishQuery(query, pages, identity, firstExposure, ordinaryCosts(elapsedCalls, elapsedMs), stopCause);
}

async function recallPublicMembershipPage(
  daemon: BenchDaemonHandle, request: OrdinaryRecallPublicRequest, ordinal: number,
  session: FirstExposureSession, firstExposure: FirstExposurePage | null
): Promise<EntryPage> {
  const args = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  // Bind the actual JSON request, not optional own undefined keys absent from the invocation.
  request = SoulMemorySearchRequestSchema.parse(args);
  let frame: BenchMcpToolCapture | undefined;
  try {
    await callMcpTool(daemon.mcpClient, "soul.recall", args, captured => { frame = captured; });
  } catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    if (frame === undefined) return membershipPage({ ordinal, request, frame: null, envelope: null, output: null,
      firstExposure: null, responseState: "transport_error", observation: "unobserved", occupiedSlots: 0, sourceIntervals: [] });
    // A captured rejection still needs envelope/output admission below; only a missing frame is transport failure.
  }
  if (frame === undefined) {
    return membershipPage({ ordinal, request, frame: null, envelope: null, output: null,
      firstExposure: null, responseState: "unknown", observation: "unobserved", occupiedSlots: 0, sourceIntervals: [] });
  }
  return admitCapturedPublicMembership({ ordinal, request, frame, args, session, firstExposure });
}

/** Invalid frames retain raw evidence on a typed failed page; CANCELLED/CONFLICT still fail closed. */
function admitCapturedPublicMembership(input: Readonly<{
  ordinal: number; request: OrdinaryRecallPublicRequest; frame: BenchMcpToolCapture; args: Record<string, unknown>;
  session: FirstExposureSession; firstExposure: FirstExposurePage | null;
}>): EntryPage {
  if (canonicalJson(input.frame.request) !== canonicalJson({ name: "soul.recall", arguments: input.args })) {
    throw new AlayaError("CONFLICT", "ordinary public MCP request differs from the captured frame");
  }
  const failed = {
    ordinal: input.ordinal, request: input.request, frame: input.frame, output: null, firstExposure: null,
    responseState: "invalid_response" as const, observation: "unobserved" as const, occupiedSlots: 0, sourceIntervals: [] as SourceInterval[]
  };
  const envelope = OrdinaryRecallEnvelopeSchema.safeParse(input.frame.response);
  if (!envelope.success) return membershipPage({ ...failed, envelope: null });
  if (envelope.data.isError === true) {
    return membershipPage({ ...failed, envelope: envelope.data, responseState: "public_error" });
  }
  let generic: unknown;
  try {
    generic = readBenchMcpToolOutput("soul.recall", input.frame.response);
  } catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    return membershipPage({ ...failed, envelope: envelope.data });
  }
  const output = SoulMemorySearchResponseSchema.safeParse(generic);
  if (!output.success) return membershipPage({ ...failed, envelope: envelope.data });
  if (canonicalJson(output.data) !== canonicalJson(generic)) {
    throw new AlayaError("CONFLICT", "public output cannot be normalized during ordinary entry admission");
  }
  return bindPublicExposure({
    ordinal: input.ordinal, request: input.request, frame: input.frame, envelope: envelope.data,
    output: freezeOrdinaryArtifact(SoulMemorySearchResponseSchema, output.data),
    session: input.session, firstExposure: input.firstExposure
  });
}

function bindPublicExposure(input: Readonly<{
  ordinal: number; request: OrdinaryRecallPublicRequest; frame: BenchMcpToolCapture; envelope: OrdinaryRecallEnvelope;
  output: SoulMemorySearchResponse; session: FirstExposureSession; firstExposure: FirstExposurePage | null;
}>): EntryPage {
  const base = {
    ordinal: input.ordinal, request: input.request, frame: input.frame, envelope: input.envelope,
    output: input.output, firstExposure: null as FirstExposurePage | null, responseState: "success" as const,
    observation: "unobserved" as const, occupiedSlots: 0, sourceIntervals: [] as SourceInterval[]
  };
  const index = input.output.index;
  if (index === undefined || index.interpretation_id === undefined || index.as_of === undefined) {
    return membershipPage(base);
  }
  let exposure: FirstExposurePage;
  try { exposure = input.session.record(input.output, input.request.continuation); }
  catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    return membershipPage(base);
  }
  // Continuation cannot mint a replacement initial page; missing initial is not evidence.
  if (input.request.continuation != null && exposure.initial === null) return membershipPage({ ...base, firstExposure: exposure });
  try { verifyExposure(capturedCall(input.ordinal, input.request, input.output, exposure), index, input.firstExposure); }
  catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    return membershipPage({ ...base, firstExposure: exposure });
  }
  if (firstExposureMismatch(exposure, {
    query_id: index.query_id, snapshot_id: index.snapshot_id, interpretation_id: index.interpretation_id, as_of: index.as_of
  }, exposureSlots(input.output), input.output.delivery_id)) {
    return membershipPage({ ...base, firstExposure: exposure });
  }
  return membershipPage({
    ...base, firstExposure: exposure, observation: "observed",
    occupiedSlots: exposureSlots(input.output).length, sourceIntervals: sourceIntervals(input.output)
  });
}

function capturedCall(
  ordinal: number, request: OrdinaryRecallPublicRequest, output: SoulMemorySearchResponse, exposure: FirstExposurePage
): CapturedOrdinaryRecallCall {
  return {
    request: OrdinaryRecallRequestRecordSchema.parse({
      ordinal, phase: "membership", tool: "soul.recall", arguments: request,
      reserved_at: new Date().toISOString(), retry: false
    }),
    envelope: null, output, firstExposure: exposure, contexts: [], transportError: null, responseState: "success"
  };
}

function sourceIntervals(output: SoulMemorySearchResponse): SourceInterval[] {
  return output.results.flatMap((row, slot_index) => {
    if (row.target.kind !== "source_evidence" || row.target.span === undefined) return [];
    return [{ slot_index, target: row.target, span: row.target.span }];
  });
}

function snapshotIdentity(
  index: NonNullable<SoulMemorySearchResponse["index"]>, clock: string
): SnapshotIdentity {
  if (index.interpretation_id === undefined || index.as_of === undefined) {
    throw new AlayaError("UNAVAILABLE", "ordinary public index lacks query identity");
  }
  if (index.as_of !== clock) throw new AlayaError("CONFLICT", "ordinary public clock differs from the sealed interpretation clock");
  return {
    query_id: index.query_id, snapshot_id: index.snapshot_id, result_version: index.result_version,
    interpretation_id: index.interpretation_id, as_of: index.as_of
  };
}

function freezeOrdinaryArtifact<T>(schema: { parse(value: unknown): T }, value: T): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

function assertOrdinaryEntryOutputRoot(root: string, config: SemanticChainConfig): void {
  const physicalRoot = canonicalPath(root);
  for (const input of [config.snapshot_path, ...semanticChainCacheInputPaths({ config })]) {
    if (canonicalPathsOverlap(physicalRoot, canonicalPath(input))) {
      throw new AlayaError("VALIDATION", "ordinary entry output root must be separate from the sealed snapshot and cache inputs");
    }
  }
}

function membershipPage(input: Readonly<{
  ordinal: number; request: OrdinaryRecallPublicRequest; frame: BenchMcpToolCapture | null;
  envelope: OrdinaryRecallEnvelope | null; output: SoulMemorySearchResponse | null;
  firstExposure: FirstExposurePage | null; responseState: EntryPage["response_state"];
  observation: EntryPage["observation"]; occupiedSlots: number; sourceIntervals: readonly SourceInterval[];
}>): EntryPage {
  const index = input.output?.index;
  const unobserved = input.observation !== "observed" || index === undefined;
  return {
    ordinal: input.ordinal, phase: "membership", request: input.request,
    public_call: input.frame === null ? null : {
      request: { name: "soul.recall", arguments: input.frame.request.arguments }, response: input.frame.response
    },
    envelope: input.envelope, output: input.output, first_exposure: input.firstExposure,
    response_state: input.responseState, observation: input.observation, occupied_slots: input.occupiedSlots,
    source_intervals: [...input.sourceIntervals],
    complete: !unobserved,
    continuation: unobserved || index === undefined ? "unknown" : index.continuation === null ? "none" : "present",
    terminal_tail: unobserved || index === undefined
      ? { status: "unknown", reason: pageUnobservedReason(input.responseState) }
      : admittedSourceDeliveryTail(index),
    reason: unobserved ? pageUnobservedReason(input.responseState) : null
  };
}

function finishQuery(
  query: { query_key: string; original_query: string },
  pages: readonly EntryPage[], identity: SnapshotIdentity | null,
  firstExposure: FirstExposurePage | null, costs: OrdinaryRecallQueryRow["costs"],
  stopCause: OrdinaryRecallQueryRow["stop_cause"], forced?: OrdinaryRecallQueryRow["status"], reason?: string
): OrdinaryRecallQueryRow {
  const observed = pages.filter(page => page.observation === "observed");
  const intervals: SourceInterval[] = [];
  let occupied = 0;
  for (const page of observed) {
    for (const interval of page.source_intervals) intervals.push({ ...interval, slot_index: occupied + interval.slot_index });
    occupied += page.occupied_slots;
  }
  const status = forced ?? decideStatus(pages, firstExposure, stopCause);
  return {
    query_key: query.query_key, original_query: query.original_query, status,
    ...(status === "complete" && reason === undefined ? {} : { reason: reason ?? ordinaryEntryStatusReason(status, stopCause, pages.at(-1)) }),
    snapshot_identity: identity, pages: [...pages], page_count: pages.length, stop_cause: stopCause,
    first_exposure: firstExposure,
    source_intervals: firstExposure?.initial == null ? [] : intervals,
    unobserved_counters: [...UNOBSERVED_ORDINARY_COUNTERS], costs
  };
}

function decideStatus(
  pages: readonly EntryPage[], firstExposure: FirstExposurePage | null,
  stopCause: OrdinaryRecallQueryRow["stop_cause"]
): OrdinaryRecallQueryRow["status"] {
  if (firstExposure?.initial == null || pages.every(page => page.observation !== "observed")) {
    return stopCause === "failed" ? "failed" : "unavailable";
  }
  if (pages.some(page => page.observation !== "observed")) return "partial";
  return stopCause === "observed_ten_slot_prefix" || stopCause === "occupancy_tail_exhausted" ? "complete" : "partial";
}

/** Status text follows the structured stop and last page; it must not claim a continuation was issued. */
export function ordinaryEntryStatusReason(
  status: OrdinaryRecallQueryRow["status"], stopCause: OrdinaryRecallQueryRow["stop_cause"],
  last: Readonly<{
    observation: OrdinaryRecallQueryRow["pages"][number]["observation"];
    response_state: OrdinaryRecallQueryRow["pages"][number]["response_state"];
    reason: string | null;
  }> | undefined
): string {
  if (status === "complete") {
    return stopCause === "occupancy_tail_exhausted"
      ? "ordinary public occupancy tail exhausted" : "ordinary public membership window captured";
  }
  if (status === "partial") return partialStatusReason(stopCause, last);
  if (status === "failed") return last?.reason ?? pageUnobservedReason(last?.response_state ?? "unknown");
  if (last?.response_state === "transport_error") return "ordinary public soul.recall transport did not yield an envelope";
  return "ordinary public soul.recall did not supply required first-exposure or source-interval evidence";
}

function partialStatusReason(
  stopCause: OrdinaryRecallQueryRow["stop_cause"],
  last: Readonly<{ observation: EntryPage["observation"]; response_state: EntryPage["response_state"]; reason: string | null }> | undefined
): string {
  if (stopCause === "no_issued_continuation") {
    return "ordinary public membership issued no continuation before ten occupied slots";
  }
  if (stopCause === "membership_page_bound") {
    return "ordinary public membership reached the page bound before ten occupied slots";
  }
  if (stopCause === "terminal_index") {
    return "ordinary public membership stopped at a terminal index before ten occupied slots";
  }
  if (last?.observation !== "observed") {
    return last?.reason ?? pageUnobservedReason(last?.response_state ?? "unknown");
  }
  return last.reason ?? "ordinary public membership repeated a cursor or delivery position";
}

function emptyRow(
  query: { query_key: string; original_query: string }, status: OrdinaryRecallQueryRow["status"], reason: string
): OrdinaryRecallQueryRow {
  return {
    query_key: query.query_key, original_query: query.original_query, status, reason, snapshot_identity: null,
    pages: [], page_count: 0, stop_cause: status === "not_run" ? "not_run" : "unavailable",
    first_exposure: null, source_intervals: [], unobserved_counters: [...UNOBSERVED_ORDINARY_COUNTERS],
    costs: ordinaryCosts(0, 0)
  };
}

function pageUnobservedReason(responseState: EntryPage["response_state"]): string {
  if (responseState === "invalid_response") return "ordinary public soul.recall captured an invalid envelope or output";
  if (responseState === "public_error") return "ordinary public soul.recall returned an error envelope";
  if (responseState === "transport_error") return "ordinary public soul.recall transport did not yield an envelope";
  return "ordinary public soul.recall did not supply required first-exposure or source-interval evidence";
}

function ordinaryCosts(elapsedCalls: number, elapsedMs: number): OrdinaryRecallQueryRow["costs"] {
  return {
    work_units: { status: "unavailable", reason: "public_soul_recall_omits_native_work" },
    read_bytes: { status: "unavailable", reason: "public_soul_recall_omits_read_bytes" },
    latency_ms: elapsedCalls === 0
      ? { status: "unavailable", reason: "no_public_call_elapsed" }
      : { status: "available", value: elapsedMs, source: "client_mcp_elapsed" }
  };
}

function ordinaryEntryPositionKey(target: SoulMemorySearchResponse["results"][number]["target"]): string {
  if (target.kind !== "source_evidence") return canonicalJson(target);
  const { span: _span, ...root } = target;
  return canonicalJson(root);
}

function refuseReplayedOrdinaryPage(
  page: EntryPage, request: OrdinaryRecallPublicRequest, seen: OrdinaryEntryCursorSeen
): EntryPage | null {
  const output = page.output;
  if (output === null) return null;
  const reason = admitOrdinaryEntryCursor(seen, {
    delivery_id: output.delivery_id, request_continuation: request.continuation ?? null,
    issued_continuation: output.index?.continuation ?? null,
    positions: output.results.map(result => ordinaryEntryPositionKey(result.target))
  });
  if (reason === null) return null;
  return {
    ...page, observation: "unobserved", occupied_slots: 0, source_intervals: [], complete: false,
    continuation: "unknown", terminal_tail: { status: "unknown", reason }, reason
  };
}
