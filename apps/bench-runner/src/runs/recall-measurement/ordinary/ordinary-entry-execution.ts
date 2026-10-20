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
import { terminal, verifyExposure } from "./ordinary-recall-delivery.js";
import {
  OrdinaryRecallEntryInputSchema, OrdinaryRecallExecutionSchema, OrdinaryRecallQueryRowSchema,
  OrdinaryRecallSourceIntervalSchema, ORDINARY_RECALL_ENTRY_CONTRACT, ORDINARY_RECALL_PUBLIC_PAGE_LIMIT,
  ORDINARY_RECALL_PUBLIC_PAGE_SLOTS, ORDINARY_RECALL_UNMAPPED_DIMENSIONS, UNOBSERVED_ORDINARY_COUNTERS,
  buildOrdinaryRecallRequest, mapOrdinaryRecallScope, type OrdinaryRecallExecution, type OrdinaryRecallMapping,
  type OrdinaryRecallPublicRequest, type OrdinaryRecallQueryRow
} from "./ordinary-entry-contract.js";

type SourceInterval = z.infer<typeof OrdinaryRecallSourceIntervalSchema>;
type SnapshotIdentity = NonNullable<OrdinaryRecallQueryRow["snapshot_identity"]>;
type EntryPage = OrdinaryRecallQueryRow["pages"][number];

/**
 * Callable public `soul.recall` launcher (not a CLI, scorer, or gold join).
 * `executeOrdinaryRecallEntry({ config, root, queries })` parses `SemanticChainConfig` and
 * `{ query_key, original_query }[]`, restores the snapshot with `withSemanticChainDaemon`,
 * and calls `callMcpTool(daemon.mcpClient, "soul.recall", args, capture)`.
 * Writes `root/ordinary-entry.json`. Each observed page sets `occupied_slots` from admitted
 * `exposureSlots`, not `source_intervals.length` (0 when the page is not admitted).
 */
export async function executeOrdinaryRecallEntry(value: unknown): Promise<OrdinaryRecallExecution> {
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
        const parsed = OrdinaryRecallExecutionSchema.parse(retained);
        if (parsed.input_identity !== identity) {
          throw new AlayaError("CONFLICT", "ordinary entry artifact does not bind the requested config and queries");
        }
        return parsed;
      }
      const execution = freezeOrdinaryArtifact(OrdinaryRecallExecutionSchema, mapped.status === "not_run"
        ? notRunExecution(config, mapped, identity, input.queries)
        : await runMappedOrdinaryRecall(config, input.root, input.queries, mapped, identity));
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
    max_results: ORDINARY_RECALL_PUBLIC_PAGE_SLOTS, unmapped_dimensions
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
  mapping: Extract<OrdinaryRecallMapping, { status: "mapped" }>, identity: string
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
        if (canonicalJson(reserved) !== canonicalJson({ entry_identity: identity, query_key: query.query_key })) {
          throw new AlayaError("CONFLICT", "ordinary public row does not bind its requested entry identity");
        }
        rows.push(OrdinaryRecallQueryRowSchema.parse(prior)); continue;
      }
      if (reserved !== undefined) {
        throw new AlayaError("CONFLICT", "ordinary public first exposure is unresolved after interruption; retained reservation forbids re-exposure");
      }
      writeChainArtifact(reservation, { entry_identity: identity, query_key: query.query_key });
      const row = await executeOrdinaryQuery(daemon, config, mapping, query);
      const frozen = freezeOrdinaryArtifact(OrdinaryRecallQueryRowSchema, row);
      writeChainArtifact(rowPath, frozen);
      rows.push(frozen);
    }
  });
  return {
    contract: ORDINARY_RECALL_ENTRY_CONTRACT, input_identity: identity, config_identity: chainIdentity(config), mapping,
    consumer_model_calls: 0, rows
  };
}

async function executeOrdinaryQuery(
  daemon: BenchDaemonHandle, config: SemanticChainConfig,
  mapping: Extract<OrdinaryRecallMapping, { status: "mapped" }>,
  query: { query_key: string; original_query: string }
): Promise<OrdinaryRecallQueryRow> {
  const firstRequest = buildOrdinaryRecallRequest({
    query: query.original_query, scope_class: mapping.scope_class, source_observed_at: config.interpretation_clock
  });
  const session = new FirstExposureSession();
  const pages: EntryPage[] = [];
  let identity: SnapshotIdentity | null = null;
  let firstExposure: FirstExposurePage | null = null;
  let request: OrdinaryRecallPublicRequest = firstRequest;
  try {
    for (let ordinal = 1; ordinal <= ORDINARY_RECALL_PUBLIC_PAGE_LIMIT; ordinal += 1) {
      const page = await recallPublicMembershipPage(daemon, request, ordinal, session, firstExposure);
      pages.push(page);
      if (page.observation !== "observed" || page.output?.index === undefined) break;
      const index = page.output.index;
      const nextIdentity = snapshotIdentity(index, config.interpretation_clock);
      if (identity === null) identity = nextIdentity;
      else if (canonicalJson(identity) !== canonicalJson(nextIdentity)) {
        throw new AlayaError("CONFLICT", "ordinary public query or snapshot identity changed");
      }
      firstExposure ??= page.first_exposure;
      if (index.continuation == null || terminal(index) || ordinal === ORDINARY_RECALL_PUBLIC_PAGE_LIMIT) break;
      request = SoulMemorySearchRequestSchema.parse({ ...firstRequest, continuation: index.continuation });
    }
  } catch (error) {
    refuseBenchWorkAfterCancel();
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    return finishQuery(query, pages, identity, firstExposure, "unavailable",
      error instanceof Error ? error.message : String(error));
  }
  return finishQuery(query, pages, identity, firstExposure);
}

async function recallPublicMembershipPage(
  daemon: BenchDaemonHandle, request: OrdinaryRecallPublicRequest, ordinal: number,
  session: FirstExposureSession, firstExposure: FirstExposurePage | null
): Promise<EntryPage> {
  const args = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  let frame: BenchMcpToolCapture | undefined;
  try {
    await callMcpTool(daemon.mcpClient, "soul.recall", args, captured => { frame = captured; });
  } catch (error) {
    if (error instanceof AlayaError && (error.code === "CANCELLED" || error.code === "CONFLICT")) throw error;
    if (frame === undefined) return membershipPage({ ordinal, request, frame: null, envelope: null, output: null,
      firstExposure: null, responseState: "transport_error", observation: "unobserved", occupiedSlots: 0, sourceIntervals: [] });
    const envelope = OrdinaryRecallEnvelopeSchema.safeParse(frame.response);
    return membershipPage({
      ordinal, request, frame, envelope: envelope.success ? envelope.data : null,
      output: null, firstExposure: null, responseState: "public_error", observation: "unobserved", occupiedSlots: 0,
      sourceIntervals: []
    });
  }
  if (frame === undefined) {
    return membershipPage({ ordinal, request, frame: null, envelope: null, output: null,
      firstExposure: null, responseState: "unknown", observation: "unobserved", occupiedSlots: 0, sourceIntervals: [] });
  }
  if (canonicalJson(frame.request) !== canonicalJson({ name: "soul.recall", arguments: args })) {
    throw new AlayaError("CONFLICT", "ordinary public MCP request differs from the captured frame");
  }
  const envelope = OrdinaryRecallEnvelopeSchema.parse(frame.response);
  const generic = readBenchMcpToolOutput("soul.recall", frame.response);
  const output = SoulMemorySearchResponseSchema.parse(generic);
  if (canonicalJson(output) !== canonicalJson(generic)) {
    throw new AlayaError("CONFLICT", "public output cannot be normalized during ordinary entry admission");
  }
  return bindPublicExposure({ ordinal, request, frame, envelope, output, session, firstExposure });
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
    if (error instanceof AlayaError && error.code === "CANCELLED") throw error;
    return membershipPage(base);
  }
  // Continuation cannot mint a replacement initial page; missing initial is not evidence.
  if (input.request.continuation != null && exposure.initial === null) return membershipPage({ ...base, firstExposure: exposure });
  try { verifyExposure(capturedCall(input.ordinal, input.request, input.output, exposure), index, input.firstExposure); }
  catch (error) {
    if (error instanceof AlayaError && error.code === "CANCELLED") throw error;
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
  return {
    ordinal: input.ordinal, phase: "membership", request: input.request,
    public_call: input.frame === null ? null : {
      request: { name: "soul.recall", arguments: input.frame.request.arguments }, response: input.frame.response
    },
    envelope: input.envelope, output: input.output, first_exposure: input.firstExposure,
    response_state: input.responseState, observation: input.observation, occupied_slots: input.occupiedSlots,
    source_intervals: [...input.sourceIntervals]
  };
}

function finishQuery(
  query: { query_key: string; original_query: string },
  pages: readonly EntryPage[], identity: SnapshotIdentity | null,
  firstExposure: FirstExposurePage | null, forced?: OrdinaryRecallQueryRow["status"], reason?: string
): OrdinaryRecallQueryRow {
  const observed = pages.filter(page => page.observation === "observed");
  const intervals: SourceInterval[] = [];
  let occupied = 0;
  for (const page of observed) {
    for (const interval of page.source_intervals) intervals.push({ ...interval, slot_index: occupied + interval.slot_index });
    occupied += page.occupied_slots;
  }
  const status = forced ?? decideStatus(pages, firstExposure);
  return {
    query_key: query.query_key, original_query: query.original_query, status,
    ...(status === "complete" && reason === undefined ? {} : { reason: reason ?? statusReason(status, pages.at(-1)) }),
    snapshot_identity: identity, pages: [...pages], first_exposure: firstExposure,
    source_intervals: firstExposure?.initial == null ? [] : intervals,
    unobserved_counters: [...UNOBSERVED_ORDINARY_COUNTERS]
  };
}

function decideStatus(pages: readonly EntryPage[], firstExposure: FirstExposurePage | null): OrdinaryRecallQueryRow["status"] {
  if (firstExposure?.initial == null || pages.every(page => page.observation !== "observed")) {
    return pages.some(page => page.response_state === "public_error") && pages.every(page => page.observation !== "observed")
      ? "failed" : "unavailable";
  }
  return pages.some(page => page.observation !== "observed") ? "partial" : "complete";
}

function statusReason(status: OrdinaryRecallQueryRow["status"], last: EntryPage | undefined): string {
  if (status === "complete") return "ordinary public membership window captured";
  if (status === "partial") return "ordinary public continuation was issued but the @10 window is incomplete";
  if (status === "failed") return "ordinary public soul.recall returned an error envelope";
  if (last?.response_state === "transport_error") return "ordinary public soul.recall transport did not yield an envelope";
  return "ordinary public soul.recall did not supply required first-exposure or source-interval evidence";
}

function emptyRow(
  query: { query_key: string; original_query: string }, status: OrdinaryRecallQueryRow["status"], reason: string
): OrdinaryRecallQueryRow {
  return {
    query_key: query.query_key, original_query: query.original_query, status, reason, snapshot_identity: null,
    pages: [], first_exposure: null, source_intervals: [], unobserved_counters: [...UNOBSERVED_ORDINARY_COUNTERS]
  };
}
