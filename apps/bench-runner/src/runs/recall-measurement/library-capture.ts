import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AlayaError, canonicalJson, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SoulInterpretationResponse, type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { z } from "zod";
import { currentBenchScope, refuseBenchWorkAfterCancel, trackBenchOperation } from "../../harness/daemon-task.js";
import { callMcpTool, readBenchMcpToolOutput, type BenchMcpToolCapture } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { admitEvaluatorOutputRoot } from "../measurement/evaluator-output.js";
import { FirstExposurePageSchema, FirstExposureSession } from "../measurement/first-exposure-session.js";
import { recordSourceSemanticLibraryFirstExposure } from "../measurement/source-semantic-library-recall.js";
import { admitSourceSemanticLibraryContinuation, admitSourceSemanticLibraryResponse,
  deliveredSourceSemanticLibraryPageIntervals, refusesSourceSemanticLibraryFamily } from "../measurement/source-semantic-library-measurement.js";
import { admittedSourceDeliveryTail } from "../measurement/source-delivery-visibility.js";
import type { ConsumerVisibilityPage } from "../longmemeval-semantic/message-visibility.js";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import type { SourceSemanticObservedCall } from "../../../../core-daemon/src/runtime/recall/source-semantic-observation.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import { admitSealedSemanticChainLibraryDelivery, semanticChainLibraryRecallRequest } from "./library-admission.js";
import { assertChainSnapshot, assertMemoryEmbeddingReceipts, chainIdentity, readChainArtifact, SemanticChainPlanSchema, withSemanticChainDaemon,
  writeChainArtifact, type SemanticChainPlan } from "./contract.js";
import { readSemanticChainCorrespondences, semanticChainCacheInputPaths, semanticChainQueryCorrespondences,
  verifySemanticChainQueries } from "./inputs.js";
import { executeSemanticChainQuery, ReplayRowSchema, ReplaySchema } from "./replay.js";

type Recall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
const CONTRACT = "source-semantic-library-capture-v1" as const;
const HeaderSchema = z.object({ contract: z.literal(CONTRACT), mode: z.literal("library"), max_pages: z.union([z.literal(1), z.literal(2)]),
  execution_observation: z.enum(["enabled", "disabled"]),
  output_root: z.string(), plan_identity: z.string(), correspondence_identity: z.string(),
  arm: z.enum(["retained", "without_semantic_correspondences"]), identity: z.string() }).strict();
const NativePageSchema = z.object({ response: SoulInterpretationResponseSchema, first_exposure: FirstExposurePageSchema.nullable() }).strict();
const StopSchema = z.object({ status: z.enum(["captured", "partial", "blocked"]), reason: z.string(),
  page2: z.enum(["not_requested", "not_issued", "observed", "refused", "failed"]) }).strict();
type Stop = z.infer<typeof StopSchema>;

export type SemanticChainLibraryCaptureOptions = Readonly<{
  maxPages: 1 | 2;
  arm?: "retained" | "without_semantic_correspondences";
  /** Private startup observations remain owned by the daemon seam, not this page recorder. */
  daemonOptions?: Parameters<typeof withSemanticChainDaemon>[3];
  observeExecution?: <T>(work: () => Promise<T>, context: Readonly<{ daemon: BenchDaemonHandle; queryKey: string }>) =>
    Promise<SourceSemanticObservedCall<T>>;
}>;

type SemanticChainLibraryCaptureHeader = z.infer<typeof HeaderSchema>;
type SemanticChainLibraryCaptureInitial = z.infer<typeof ReplaySchema>["rows"][number];
const ExecutionObservationSchema = z.object({ capture_identity: z.string(), query_key: z.string(),
  status: z.enum(["available", "unavailable", "not_observed", "overflow"]), observations: z.array(z.unknown()),
  outcome: z.enum(["success", "failure"]), error: z.unknown().optional() }).strict();
type SemanticChainLibraryObservedExecution = z.infer<typeof ExecutionObservationSchema>;
type SemanticChainLibraryRunObservation =
  | Readonly<{ status: "unobserved"; observations: null }>
  | SemanticChainLibraryObservedExecution;

/** Blocked rows keep empty records; unadmitted partials omit them; admitted pages retain sealed identities. */
type SemanticChainLibraryCaptureRow =
  | Readonly<{ query_key: string; status: "blocked"; reason: string; pages: readonly ConsumerVisibilityPage[];
      initial: null; source_records: readonly SourceRecordIdentity[];
      execution_observation: Readonly<{ status: "not_run"; observations: null }> }>
  | Readonly<{ query_key: string; status: "partial"; reason: string; pages: readonly ConsumerVisibilityPage[];
      initial: SemanticChainLibraryCaptureInitial | null; source_records?: undefined;
      execution_observation: SemanticChainLibraryRunObservation }>
  | Readonly<{ query_key: string; status: "captured" | "partial"; reason: string; pages: readonly ConsumerVisibilityPage[];
      initial: SemanticChainLibraryCaptureInitial; source_records: readonly SourceRecordIdentity[];
      execution_observation: SemanticChainLibraryRunObservation }>;

type SemanticChainLibraryCaptureResult = Readonly<{
  header: SemanticChainLibraryCaptureHeader; plan: SemanticChainPlan; rows: readonly SemanticChainLibraryCaptureRow[];
}>;

/** Private, no-gold execution. Every invocation owns a fresh output root; never resumes or re-exposes a reservation. */
export async function captureSemanticChainLibrary(root: string, outputRoot: string, options: SemanticChainLibraryCaptureOptions):
  Promise<SemanticChainLibraryCaptureResult & Readonly<{ path: string }>> {
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    if (options.maxPages !== 1 && options.maxPages !== 2) throw new AlayaError("VALIDATION", "library capture permits one or two pages");
    const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
    assertChainSnapshot(plan.config);
    verifySemanticChainQueries(plan);
    const arm = options.arm ?? "retained";
    const retained = readSemanticChainCorrespondences(plan, arm);
    const output = admitEvaluatorOutputRoot(outputRoot, [root, plan.config.snapshot_path, ...semanticChainCacheInputPaths(plan)]);
    const material = { contract: CONTRACT, mode: "library" as const, max_pages: options.maxPages,
      execution_observation: options.observeExecution === undefined ? "disabled" as const : "enabled" as const,
      output_root: output, plan_identity: chainIdentity(plan), correspondence_identity: retained.identity, arm };
    const header = HeaderSchema.parse({ ...material, identity: chainIdentity(material) });
    mkdirSync(dirname(output), { recursive: true });
    // mkdir is the fresh-run claim: neither an existing capture nor a partial reservation can be reused.
    mkdirSync(output);
    writeChainArtifact(join(output, "capture-owner.json"), header);
    const run = async (daemon: BenchDaemonHandle) => {
      for (const query of plan.queries) {
        refuseBenchWorkAfterCancel();
        const directory = join(output, query.query_key);
        if (query.status === "blocked") {
          writeChainArtifact(join(directory, "stop.json"), { status: "blocked", reason: query.reason, page2: "not_issued" });
          continue;
        }
        const { ready, outcomes } = query.status === "ready"
          ? semanticChainQueryCorrespondences(query, retained.semantic_correspondences) : { ready: [], outcomes: [] };
        const session = new FirstExposureSession();
        const first = pageRecorder(directory, header.identity, query.query_key, 1);
        const execute = async (): Promise<Stop> => {
          const row = ReplayRowSchema.parse(await executeSemanticChainQuery({ daemon, config: plan.config, query,
            ready: arm === "retained" ? ready : [], outcomes, rowPath: join(directory, "initial.json"), replayIdentity: header.identity,
            exposureSession: session, beforeRequest: first.reserve, capture: first.capture }));
          if (row.status !== "replayed" || row.response?.operation !== "recall" || row.first_exposure == null) {
            // The delivered family is decided before the exposure prerequisite, so a refused
            // family keeps its own cause instead of reading as an unavailable delivery.
            return { status: "partial", reason: refusesSourceSemanticLibraryFamily(row.response)
              ? "unsupported_library_family" : "initial_delivery_unavailable", page2: "not_issued" };
          }
          if (options.maxPages === 1 || row.response.index?.continuation == null) {
            return { status: "captured", reason: options.maxPages === 1 ? "requested_page_bound" : "no_issued_continuation",
              page2: options.maxPages === 1 ? "not_requested" : "not_issued" };
          }
          return await continueLibraryCapture(daemon, directory, header.identity, query.query_key, row.response, first.request(), session);
        };
        const observed = options.observeExecution === undefined ? await unobservedExecution(execute)
          : await options.observeExecution(execute, { daemon, queryKey: query.query_key });
        retainExecutionObservation(directory, header.identity, query.query_key, observed);
        if (observed.outcome.status === "failure") throw observed.outcome.error;
        writeChainArtifact(join(directory, "stop.json"), observed.outcome.value);
      }
    };
    if (plan.queries.some(query => query.status !== "blocked")) {
      await withSemanticChainDaemon(plan.config, output, run, options.daemonOptions);
    } else for (const query of plan.queries) {
      writeChainArtifact(join(output, query.query_key, "stop.json"), { status: "blocked", reason: query.status === "blocked" ? query.reason : "", page2: "not_issued" });
    }
    writeChainArtifact(join(output, "capture.json"), { contract: CONTRACT, identity: header.identity,
      query_keys: plan.queries.map(query => query.query_key) });
    return { path: join(output, "capture.json"), ...admitSemanticChainLibraryCapture(root, output) };
  };
  const scope = currentBenchScope();
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

class CaptureArchiveError extends Error {}

async function unobservedExecution<T>(work: () => Promise<T>): Promise<SourceSemanticObservedCall<T>> {
  try { return { outcome: { status: "success", value: await work() }, observations: [], status: "not_observed" }; }
  catch (error) { return { outcome: { status: "failure", error }, observations: [], status: "not_observed" }; }
}

/** Failure observations commit before the original error escapes; archive failure must not erase it. */
function retainExecutionObservation<T>(directory: string, identity: string, queryKey: string, observed: SourceSemanticObservedCall<T>): void {
  try {
    writeChainArtifact(join(directory, "execution-observation.json"), { capture_identity: identity, query_key: queryKey,
      status: observed.status, observations: observed.observations, outcome: observed.outcome.status,
      ...(observed.outcome.status === "success" ? {} : { error: observed.outcome.error instanceof Error
        ? { name: observed.outcome.error.name, message: observed.outcome.error.message } : { thrown: String(observed.outcome.error) } }) });
  } catch (archive) {
    if (observed.outcome.status === "success") throw archive;
    throw new AlayaError("UNAVAILABLE", "library execution and observation archive failed", { cause: { earlier: observed.outcome.error, archive } });
  }
}

/** A request is reserved before MCP; the helper freezes the independent received envelope before parsing. */
function pageRecorder(directory: string, captureIdentity: string, queryKey: string, page: 1 | 2) {
  const path = join(directory, `page-${page}`);
  let request: Record<string, unknown> | undefined;
  return {
    request: () => {
      if (request === undefined) throw new AlayaError("CONFLICT", "captured page has no reserved request");
      return structuredClone(request);
    },
    reserve: (args: Record<string, unknown>) => {
      request = structuredClone(args);
      writeChainArtifact(`${path}.reserved`, { capture_identity: captureIdentity, query_key: queryKey, page,
        request_identity: chainIdentity({ name: "soul.interpretation", arguments: request }) });
      writeChainArtifact(`${path}.request.json`, { name: "soul.interpretation", arguments: request });
    },
    capture: (frame: BenchMcpToolCapture) => {
      try { writeChainArtifact(`${path}.mcp.json`, frame); }
      catch (error) { throw new CaptureArchiveError("library MCP archive write failed", { cause: error }); }
    }
  };
}

async function continueLibraryCapture(daemon: BenchDaemonHandle, directory: string,
  identity: string, queryKey: string, initial: Recall, initialRequest: Record<string, unknown>, session: FirstExposureSession): Promise<Stop> {
  refuseBenchWorkAfterCancel();
  const continuation = initial.index!.continuation!;
  const next = pageRecorder(directory, identity, queryKey, 2);
  const request = SoulInterpretationRequestSchema.parse({ ...initialRequest, continuation });
  next.reserve(request);
  const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation", request, next.capture));
  refuseBenchWorkAfterCancel();
  if (response.operation !== "recall") throw new AlayaError("CONFLICT", "native continuation changed operation");
  const first_exposure = refusesSourceSemanticLibraryFamily(response) || response.index === undefined || response.delivery_id === undefined ? null
    : recordSourceSemanticLibraryFirstExposure(response, session, continuation);
  writeChainArtifact(join(directory, "page-2.native.json"), { response, first_exposure });
  // A known unsupported family is refused by its own authority; a missing continuation
  // exposure keeps the separate continuation refusal it actually is.
  if (refusesSourceSemanticLibraryFamily(response)) {
    return { status: "partial", reason: "unsupported_library_family", page2: "refused" };
  }
  return { status: first_exposure === null ? "partial" : "captured", reason: first_exposure === null
    ? "continuation_refused" : "requested_page_bound", page2: first_exposure === null ? "refused" : "observed" };
}

/** Frozen archive admission can recover an observed first page even if page 2 or aggregation was interrupted. */
export function admitSemanticChainLibraryCapture(root: string, outputRoot: string): SemanticChainLibraryCaptureResult {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  assertChainSnapshot(plan.config);
  verifySemanticChainQueries(plan);
  const header = HeaderSchema.parse(readChainArtifact(join(outputRoot, "capture-owner.json")));
  const { identity, ...material } = header;
  const output = admitEvaluatorOutputRoot(outputRoot, [root, plan.config.snapshot_path, ...semanticChainCacheInputPaths(plan)]);
  const retained = readSemanticChainCorrespondences(plan, header.arm);
  if (identity !== chainIdentity(material) || output !== header.output_root || header.plan_identity !== chainIdentity(plan)
    || header.correspondence_identity !== retained.identity) throw new AlayaError("CONFLICT", "library capture owner changed");
  if (plan.queries.some(query => query.status !== "blocked" && ["initial.json", "execution-observation.json"]
    .some(name => existsSync(join(output, query.query_key, name))))) {
    assertMemoryEmbeddingReceipts(plan.config, output, "complete");
  }
  const aggregate = readChainArtifact(join(output, "capture.json"));
  if (aggregate !== undefined) same(aggregate, { contract: CONTRACT, identity, query_keys: plan.queries.map(query => query.query_key) });
  const rows = plan.queries.map((query): SemanticChainLibraryCaptureRow => {
    if (query.status === "blocked") return { query_key: query.query_key, status: "blocked" as const, reason: query.reason, pages: [],
      initial: null, source_records: [], execution_observation: { status: "not_run", observations: null } };
    const directory = join(output, query.query_key);
    const stopValue = readChainArtifact(join(directory, "stop.json"));
    const stop = stopValue === undefined ? undefined : StopSchema.parse(stopValue);
    const observed = readChainArtifact(join(directory, "execution-observation.json"));
    const execution_observation: SemanticChainLibraryRunObservation = observed === undefined
      ? { status: "unobserved", observations: null }
      : ExecutionObservationSchema.extend({ capture_identity: z.literal(identity), query_key: z.literal(query.query_key) }).parse(observed);
    const raw = readChainArtifact(join(directory, "initial.json"));
    if (raw === undefined) return { query_key: query.query_key, status: "partial" as const,
      reason: stop?.reason ?? "initial_delivery_unobserved", pages: [unobservedPage(1, "initial_delivery_unobserved")], initial: null, execution_observation };
    const initial = ReplayRowSchema.parse(raw);
    same(initial.query_key, query.query_key);
    same(readChainArtifact(join(directory, "initial.json.reserved")), { replay_identity: identity, query_key: query.query_key });
    const { ready, outcomes } = query.status === "ready"
      ? semanticChainQueryCorrespondences(query, retained.semantic_correspondences) : { ready: [], outcomes: [] };
    same(initial.correspondence_outcomes, outcomes);
    const selected = header.arm === "retained" ? ready : [];
    const pages: ConsumerVisibilityPage[] = [];
    const capturedRequest = initial.status === "replayed" && initial.response !== undefined
      ? verifyCapturedFrame(directory, identity, query.query_key, 1, initial.response) : undefined;
    const familyRefused = initial.status === "replayed" && refusesSourceSemanticLibraryFamily(initial.response);
    if (familyRefused) {
      // The unsupported family is decided from the delivered response, so it is recorded as a
      // refused page even when its first exposure (the archived prerequisite) is unavailable.
      // `source_records: []` is an explicit refusal output, not an unadmitted partial and not
      // evidence that the delivery was empty.
      return { query_key: query.query_key, status: "partial" as const,
        reason: "unsupported_library_family",
        pages: [unobservedPage(1, "unsupported_library_family")], initial, source_records: [], execution_observation };
    }
    if (initial.status !== "replayed" || initial.response?.operation !== "recall" || initial.first_exposure == null) {
      pages.push(unobservedPage(1, "initial_delivery_unavailable"));
    } else {
      same(capturedRequest!.arguments, semanticChainLibraryRecallRequest(plan.config, query, selected,
        z.string().parse(capturedRequest!.arguments.query_handle)));
      const firstInput = { recallResult: initial.response, firstExposurePage: initial.first_exposure, requestBudget: plan.config.budget };
      const first = admitSourceSemanticLibraryResponse(firstInput);
      if (first?.status !== "admitted") throw new AlayaError("CONFLICT", "library page failed measurement admission");
      const records = admitSealedSemanticChainLibraryDelivery(plan.config, query, initial.response, selected, initial.preparation_trace);
      pages.push(visibilityPage(1, first, initial.response, 0));
      const next = readChainArtifact(join(directory, "page-2.native.json"));
      if (next !== undefined) {
        if (header.max_pages !== 2) throw new AlayaError("CONFLICT", "one-page capture contains a continuation");
        const continued = NativePageSchema.parse(next);
        verifyCapturedFrame(directory, identity, query.query_key, 2, continued.response, initial.response.index!.continuation);
        if (continued.response.operation !== "recall") pages.push(unobservedPage(2, "continuation_refused"));
        else if (refusesSourceSemanticLibraryFamily(continued.response)) pages.push(unobservedPage(2, "unsupported_library_family"));
        else if (continued.first_exposure === null) pages.push(unobservedPage(2, "continuation_refused"));
        else {
          const admitted = admitSourceSemanticLibraryContinuation({ recallResult: continued.response, firstExposurePage: continued.first_exposure,
            requestBudget: plan.config.budget, previous: firstInput, requestContinuation: initial.response.index!.continuation!,
            requestIdentity: initial.response.request_identity! });
          if (admitted?.status !== "admitted") throw new AlayaError("CONFLICT", "library continuation failed measurement admission");
          records.push(...admitSealedSemanticChainLibraryDelivery(plan.config, query, continued.response, selected, initial.preparation_trace));
          pages.push(visibilityPage(2, admitted, continued.response, pages[0]!.occupied_slots));
        }
      } else if (initial.response.index!.continuation !== null) pages.push(unobservedPage(2, stop?.reason ?? "continuation_unobserved",
        header.max_pages === 1 ? "not_run" : "unobserved"));
      return { query_key: query.query_key, status: pages.every(page => page.status === "observed") ? "captured" as const : "partial" as const,
        reason: pages.find(page => page.reason === "unsupported_library_family")?.reason ?? stop?.reason ?? "capture_interrupted",
        pages, initial, source_records: records, execution_observation };
    }
    return { query_key: query.query_key, status: "partial" as const, reason: stop?.reason ?? "initial_delivery_unavailable", pages, initial, execution_observation };
  });
  return { header, plan, rows };
}

function verifyCapturedFrame(directory: string, identity: string, queryKey: string, page: 1 | 2,
  response: SoulInterpretationResponse, continuation?: unknown) {
  const path = join(directory, `page-${page}`);
  const request = z.object({ name: z.literal("soul.interpretation"), arguments: z.record(z.string(), z.unknown()) }).strict()
    .parse(readChainArtifact(`${path}.request.json`));
  same(readChainArtifact(`${path}.reserved`), { capture_identity: identity, query_key: queryKey, page, request_identity: chainIdentity(request) });
  const frame = z.object({ request: z.unknown(), response: z.unknown() }).strict().parse(readChainArtifact(`${path}.mcp.json`));
  same(frame.request, request);
  same(readBenchMcpToolOutput<SoulInterpretationResponse>(request.name, frame.response), response);
  if (page === 1 && request.arguments.continuation !== undefined) throw new AlayaError("CONFLICT", "initial capture used continuation");
  if (page === 2) {
    const first = z.object({ arguments: z.record(z.string(), z.unknown()) }).passthrough().parse(readChainArtifact(join(directory, "page-1.request.json")));
    same(request.arguments, { ...first.arguments, continuation });
  }
  return request;
}

function visibilityPage(page: number, admitted: ReturnType<typeof admitSourceSemanticLibraryResponse>, response: Recall,
  rankOffset: number): ConsumerVisibilityPage {
  const intervals = deliveredSourceSemanticLibraryPageIntervals(admitted, response, rankOffset);
  if (admitted?.status !== "admitted" || intervals === null) throw new AlayaError("CONFLICT", "library page failed measurement admission");
  return { page, status: "observed", reason: null, occupied_slots: admitted.slots.length, complete: true,
    continuation: admitted.index.continuation === null ? "none" : "present",
    terminal_tail: admittedSourceDeliveryTail(admitted.index), intervals: intervals.map(interval => ({
      rank: interval.rank, start: interval.start, end: interval.end, target: SourceGoldUnitSchema.parse({
        workspace_id: interval.target.workspace_id, root_kind: interval.target.root_kind, root_id: interval.target.root_id,
        source_version: interval.target.source_version, content_digest: interval.target.content_digest, span: interval.target.span }) })) };
}
function unobservedPage(page: number, reason: string, status: "unobserved" | "not_run" = "unobserved"): ConsumerVisibilityPage {
  return { page, status, reason, occupied_slots: 0, complete: false, continuation: "unknown",
    terminal_tail: { status: "unknown", reason }, intervals: [] };
}
function same(actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new AlayaError("CONFLICT", "library capture reservation or request binding changed");
}
