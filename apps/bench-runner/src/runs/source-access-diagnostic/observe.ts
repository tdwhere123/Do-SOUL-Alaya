import { lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AlayaError, ConditionalFieldSha256DigestSchema, SourceSemanticAccessReceiptSchema, sourceSemanticExecutionExternalAttempts,
  SoulInterpretationPrepareQueryResponseSchema, SoulInterpretationRequestSchema, canonicalJson } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { isContainedPath, samePhysicalLocation } from "../fs/opened-contained-path.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { readLongMemEvalSemanticFreeze, type LongMemEvalSemanticFreeze } from "../longmemeval-semantic/contract.js";
import { LongMemEvalPreparedSchema, verifyLongMemEvalQuestionChain,
  verifyLongMemEvalQuestionPublication } from "../longmemeval-semantic/execute.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact,
  withSemanticChainDaemon, writeChainArtifact } from "../semantic-chain/contract.js";
import { SourceAccessDiagnosticConfigSchema, SourceAccessDiagnosticObservationSchema, SourceAccessDiagnosticRowSchema,
  type SourceAccessArtifactRef, type SourceAccessDiagnosticConfig, type SourceAccessDiagnosticRow, NOT_EXERCISED } from "./contract.js";

type Prepared = ReturnType<typeof LongMemEvalPreparedSchema.parse>;
type NativePage = Readonly<{ response: ReturnType<typeof SoulInterpretationPrepareQueryResponseSchema.parse>;
  wall_ms: number }>;
const ATTEMPT_RESERVE_BYTES = 8 * 1024;
// Finite nonnegative doubles can use 17 significant digits after five leading fractional zeros.
const MAX_PRINTED_NUMBER = 0.0000010000000000000002;
const REASON_LIMIT = 500;
// A JSON-escaped control character is the longest serialization of one reason code unit.
const MAX_REASON = "\u0000".repeat(REASON_LIMIT + "publication_identity: ".length);
const DIGEST_PLACEHOLDER = "a".repeat(64);
const POOL_ID_PLACEHOLDER = ConditionalFieldSha256DigestSchema.parse(`sha256:${DIGEST_PLACEHOLDER}`);
const STOP_REASONS = SourceSemanticAccessReceiptSchema.unwrap().shape.stopping_reasons.unwrap().element.options;
const REVISION_PLACEHOLDER = `git-worktree-v1:${"a".repeat(40)}:${DIGEST_PLACEHOLDER}`;
type RunMeter = { pages: number; attempts: number; settled: number; unresolved: number;
  work: number; outputBytes: number; sourceDiskBytes: number | null; diskPeakBytes: number;
  diskBytesAtStop: number | null; admissionSnapshotBytes: number | null;
  stop: string | null; started: number; summaryReserveBytes: number; admittedAttempts: number[] };

/** Observe native raw-source access only. The source-only freeze/prepare owns publication. */
export async function observeSourceAccessDiagnostic(value: unknown, outputRoot: string) {
  const config = SourceAccessDiagnosticConfigSchema.parse(value);
  const root = resolve(outputRoot), sourceRoot = resolve(config.source_run_root);
  if (samePhysicalLocation(root, sourceRoot) || isContainedPath(sourceRoot, root)
    || isContainedPath(root, sourceRoot)) {
    throw new AlayaError("VALIDATION", "diagnostic output and source publication roots must be isolated");
  }
  if (isAbsolute(outputRoot) !== true || lstatExists(root)) {
    throw new AlayaError("CONFLICT", "diagnostic output must be a new absolute directory");
  }
  const startPayload = { contract: "source-access-diagnostic-start-v1", config,
    slots: config.expected_question_ids.flatMap((question_id) =>
      config.policies.map((policy) => ({ question_id, policy }))) };
  const admittedAttempts = Array.from({ length: startPayload.slots.length }, () => 0);
  const initialReserve = summaryReservation(config, admittedAttempts);
  if (payloadByteSize(startPayload) + initialReserve > config.limits.max_output_bytes) {
    throw new AlayaError("RESOURCE_EXHAUSTED", "diagnostic limits cannot retain the frozen denominator summary");
  }
  mkdirSync(root, { recursive: true });
  const meter: RunMeter = { pages: 0, attempts: 0, settled: 0, unresolved: 0,
    work: 0, outputBytes: 0, sourceDiskBytes: null, diskPeakBytes: 0,
    diskBytesAtStop: null, admissionSnapshotBytes: null, stop: null, started: performance.now(),
    summaryReserveBytes: initialReserve, admittedAttempts };
  // A durable denominator exists before publication validation or any MCP call.
  const startArtifact = writeMeasuredArtifact(root, "start.json", startPayload, meter, config.limits.max_output_bytes);
  const rows: SourceAccessDiagnosticRow[] = [];
  let frozen: LongMemEvalSemanticFreeze | undefined, prepared: Prepared | undefined;
  try {
    ({ frozen, prepared } = verifiedInputs(config));
    meter.sourceDiskBytes = directoryBytes(sourceRoot);
    sampleDisk(root, meter);
  }
  catch (error) { meter.stop = `source_identity: ${reasonOf(error)}`; }

  for (const [position, questionId] of config.expected_question_ids.entries()) {
    const selected = frozen?.selected[position];
    const preparedRow = prepared?.rows[position];
    let plan: ReturnType<typeof SemanticChainPlanSchema.parse> | undefined;
    if (meter.stop === null && selected !== undefined && preparedRow?.status === "prepared") {
      try {
        const directory = resolve(sourceRoot, "questions", String(selected.index).padStart(5, "0"));
        const publication = verifyLongMemEvalQuestionPublication(frozen!, selected, directory,
          readChainArtifact(preparedRow.publication_path));
        if (publication.published_count !== 0 || publication.admitted_count !== selected.source_manifest.length) {
          throw new AlayaError("CONFLICT", "source-only publication has incomplete raw source admission");
        }
        verifyLongMemEvalQuestionChain(frozen!, selected, directory, publication, preparedRow.chain_root);
        plan = SemanticChainPlanSchema.parse(readChainArtifact(join(preparedRow.chain_root, "prepare.json")));
        if (plan.queries.length !== 1 || plan.queries[0]?.status !== "raw_ready"
          || plan.queries[0].query_semantics_unavailable !== "absent" || plan.correspondence_workset !== null) {
          throw new AlayaError("CONFLICT", "source-only preparation consumed query or correspondence semantics");
        }
      } catch (error) { meter.stop = `publication_identity: ${reasonOf(error)}`; }
    }
    for (const [policyPosition, policy] of config.policies.entries()) {
      if (meter.stop !== null) { rows.push(emptyRow(questionId, selected?.index ?? null, policy, "unattempted", meter.stop)); continue; }
      if (preparedRow?.status !== "prepared" || plan === undefined || selected === undefined) {
        rows.push(emptyRow(questionId, selected?.index ?? null, policy, "failed",
          preparedRow?.status === "unavailable" ? reasonOf(preparedRow.reason) : "source-only publication is unavailable"));
        continue;
      }
      rows.push(await observeOne(config, root, selected, plan, policy, position * config.policies.length + policyPosition, meter));
    }
  }
  const diskBeforeSummary = sampleDisk(root, meter);
  if (diskBeforeSummary + meter.summaryReserveBytes > config.limits.max_disk_bytes && meter.stop === null) {
    meter.stop = "disk_bytes_limit_after_session";
  }
  if (meter.stop !== null && meter.diskBytesAtStop === null) meter.diskBytesAtStop = diskBeforeSummary;
  const outputBeforeSummary = meter.outputBytes;
  const reportBody = observationBody(config, startArtifact, rows, meter, frozen, prepared, diskBeforeSummary, outputBeforeSummary);
  let observationBytes = 0;
  let report = SourceAccessDiagnosticObservationSchema.parse(reportBody);
  // The envelope includes a digest and the byte-count fields, so resolve their digit lengths.
  for (let i = 0; i < 8; i++) {
    const next = payloadByteSize({ ...reportBody, observation_bytes: observationBytes,
      output_bytes: outputBeforeSummary + observationBytes });
    observationBytes = next;
    report = SourceAccessDiagnosticObservationSchema.parse({ ...reportBody,
      observation_bytes: next, output_bytes: outputBeforeSummary + next });
    if (payloadByteSize(report) === next) break;
  }
  if (payloadByteSize(report) !== observationBytes || observationBytes > meter.summaryReserveBytes) {
    throw new AlayaError("RESOURCE_EXHAUSTED", "diagnostic summary exceeded its reserved space");
  }
  writeChainArtifact(join(root, "observation.json"), report);
  if (statSync(join(root, "observation.json")).size !== observationBytes) {
    throw new AlayaError("CONFLICT", "diagnostic summary byte accounting changed");
  }
  return { path: join(root, "observation.json"), result: report };
}

function observationBody(config: SourceAccessDiagnosticConfig, startArtifact: SourceAccessArtifactRef,
  rows: readonly SourceAccessDiagnosticRow[], meter: RunMeter, frozen: LongMemEvalSemanticFreeze | undefined,
  prepared: Prepared | undefined, diskBeforeSummary: number, outputBeforeSummary: number) {
  return {
    contract: "source-access-diagnostic-observation-v2", config,
    freeze_identity: frozen === undefined ? null : chainIdentity(frozen),
    prepared_identity: prepared === undefined ? null : chainIdentity(prepared),
    implementation_revision: frozen?.implementation_revision ?? null,
    start_artifact: startArtifact,
    rows, status: meter.stop === null ? "complete" : "stopped", stop_reason: meter.stop,
    total_pages: meter.pages, attempted_pages: meter.attempts, settled_pages: meter.settled,
    unresolved_attempts: meter.unresolved, total_logical_work: meter.work,
    output_bytes_before_summary: outputBeforeSummary,
    observation_bytes: 0, output_bytes: 0, source_disk_bytes: meter.sourceDiskBytes,
    disk_bytes_before_summary: diskBeforeSummary,
    disk_bytes_peak_observed: meter.diskPeakBytes, disk_bytes_at_stop: meter.diskBytesAtStop,
    disk_admission_snapshot_bytes: meter.admissionSnapshotBytes,
    disk_limit_scope: "checkpointed_snapshot_reservation_not_hard_cap",
    wall_limit_scope: "checkpointed_not_hard_deadline",
    summary_reserved_bytes: meter.summaryReserveBytes,
    wall_ms: performance.now() - meter.started, ...NOT_EXERCISED
  } as const;
}

/** Bound the final envelope from the frozen slots and every attempt admitted so far. */
function summaryReservation(config: SourceAccessDiagnosticConfig, admittedAttempts: readonly number[]): number {
  const rows = config.expected_question_ids.flatMap((questionId, position) =>
    config.policies.map((policy, policyPosition) => {
      const count = admittedAttempts[position * config.policies.length + policyPosition] ?? 0;
      const indexPath = "9".repeat(23);
      const pagePaths = Array.from({ length: count }, (_, page) =>
        join("pages", indexPath, policy, `${String(page).padStart(3, "0")}.json`));
      const evidence = Array.from({ length: count }, (_, page) => {
        const base = join("attempts", indexPath, policy, String(page).padStart(3, "0"));
        return { page_number: MAX_PRINTED_NUMBER,
          started: { path: `${base}.started.json`, identity: DIGEST_PLACEHOLDER },
          result: { path: `${base}.result.json`, identity: DIGEST_PLACEHOLDER },
          page: { path: pagePaths[page]!, identity: DIGEST_PLACEHOLDER } };
      });
      return { ...emptyRow(questionId, Number.MAX_SAFE_INTEGER, policy, "unattempted", MAX_REASON),
        attempted_pages: MAX_PRINTED_NUMBER, settled_pages: MAX_PRINTED_NUMBER,
        unresolved_attempts: MAX_PRINTED_NUMBER, page_paths: pagePaths,
        attempt_paths: evidence.flatMap((item) => [item.started.path, item.result.path]),
        attempt_evidence: evidence, pool_id: POOL_ID_PLACEHOLDER,
        observed_source_count: MAX_PRINTED_NUMBER, retained_source_count: MAX_PRINTED_NUMBER,
        unvisited_sources: false, unretained_observed_sources: MAX_PRINTED_NUMBER,
        incomplete_source_bodies: MAX_PRINTED_NUMBER, source_read_bytes: MAX_PRINTED_NUMBER,
        stopping_reasons: STOP_REASONS,
        initial_logical_work: MAX_PRINTED_NUMBER, continuation_logical_work: MAX_PRINTED_NUMBER,
        native_work: MAX_PRINTED_NUMBER, logical_work: MAX_PRINTED_NUMBER,
        native_bytes: MAX_PRINTED_NUMBER, wall_ms: MAX_PRINTED_NUMBER };
    }));
  const meter: RunMeter = { pages: MAX_PRINTED_NUMBER, attempts: MAX_PRINTED_NUMBER,
    settled: MAX_PRINTED_NUMBER, unresolved: MAX_PRINTED_NUMBER, work: MAX_PRINTED_NUMBER,
    outputBytes: MAX_PRINTED_NUMBER, sourceDiskBytes: MAX_PRINTED_NUMBER,
    diskPeakBytes: MAX_PRINTED_NUMBER, diskBytesAtStop: MAX_PRINTED_NUMBER,
    admissionSnapshotBytes: MAX_PRINTED_NUMBER, stop: MAX_REASON,
    started: performance.now(), summaryReserveBytes: MAX_PRINTED_NUMBER,
    admittedAttempts: [...admittedAttempts] };
  const body = observationBody(config, { path: "start.json", identity: DIGEST_PLACEHOLDER },
    rows, meter, undefined, undefined, MAX_PRINTED_NUMBER, MAX_PRINTED_NUMBER);
  return payloadByteSize({ ...body, status: "complete", freeze_identity: DIGEST_PLACEHOLDER,
    prepared_identity: DIGEST_PLACEHOLDER, implementation_revision: REVISION_PLACEHOLDER,
    wall_ms: MAX_PRINTED_NUMBER, observation_bytes: MAX_PRINTED_NUMBER,
    output_bytes: MAX_PRINTED_NUMBER });
}

function verifiedInputs(config: SourceAccessDiagnosticConfig): { frozen: LongMemEvalSemanticFreeze; prepared: Prepared } {
  const root = resolve(config.source_run_root), preparedPath = resolve(config.prepared_path);
  if (!isContainedPath(root, preparedPath)) throw new AlayaError("VALIDATION", "prepared artifact is outside its source root");
  const frozen = readLongMemEvalSemanticFreeze(root);
  if (frozen.contract !== "longmemeval-semantic-development-v3" || frozen.config.stage !== "development"
    || canonicalJson(frozen.selected.map((row) => row.question_id)) !== canonicalJson(config.expected_question_ids)
    || canonicalJson(frozen.config.budget) !== canonicalJson(config.budget)
    || frozen.implementation_revision !== readCurrentExtractionAuthorityRevision()) {
    throw new AlayaError("CONFLICT", "diagnostic source-only freeze, membership, budget or implementation changed");
  }
  const prepared = LongMemEvalPreparedSchema.parse(readChainArtifact(preparedPath));
  if (prepared.freeze_identity !== chainIdentity(frozen)
    || canonicalJson(prepared.rows.map((row) => row.question_id)) !== canonicalJson(config.expected_question_ids)) {
    throw new AlayaError("CONFLICT", "diagnostic prepared denominator or freeze identity changed");
  }
  return { frozen, prepared };
}

async function observeOne(config: SourceAccessDiagnosticConfig, root: string,
  selected: LongMemEvalSemanticFreeze["selected"][number], plan: ReturnType<typeof SemanticChainPlanSchema.parse>,
  policy: SourceAccessDiagnosticConfig["policies"][number], slot: number,
  meter: RunMeter): Promise<SourceAccessDiagnosticRow> {
  const paths: string[] = [], attemptPaths: string[] = [];
  const attemptEvidence: SourceAccessDiagnosticRow["attempt_evidence"] = [];
  const memberIds = new Set(selected.source_manifest.map((source) => source.source_id));
  let poolId: string | null = null, inputId: string | null = null, observed: number | null = null;
  let retained = 0, unvisited: boolean | null = null, nativeWork = 0, logicalWork = 0, nativeBytes = 0;
  let incompleteBodies = 0, sourceReadBytes = 0, initialLogicalWork = 0, continuationLogicalWork = 0;
  const stoppingReasons = new Set<string>();
  const seen = new Set<string>(), continuations = new Set<string>();
  let attemptedPages = 0, settledPages = 0, unresolvedAttempts = 0, pendingAttempt = false;
  let status: SourceAccessDiagnosticRow["status"] = "partial", reason: string | null = null;
  const started = performance.now();
  try {
    const admission = admitSession(config, root, plan, slot, meter);
    if (admission !== null) return SourceAccessDiagnosticRowSchema.parse({
      ...emptyRow(selected.question_id, selected.index, policy, "unattempted", admission),
      wall_ms: performance.now() - started });
    await withSemanticChainDaemon(plan.config, join(root, "sessions", String(selected.index), policy), async (daemon) => {
      let continuation: string | undefined;
      for (let pageNumber = 0; pageNumber < config.limits.max_pages_per_observation; pageNumber++) {
        const limit = reachedLimit(config, root, meter, slot);
        if (limit !== null) { meter.stop = limit; reason = limit; break; }
        meter.admittedAttempts[slot]!++;
        meter.summaryReserveBytes = Math.max(meter.summaryReserveBytes,
          summaryReservation(config, meter.admittedAttempts));
        const attemptBase = join("attempts", String(selected.index).padStart(5, "0"), policy, String(pageNumber).padStart(3, "0"));
        const startedPath = `${attemptBase}.started.json`;
        const startedRef = writeMeasuredArtifact(root, startedPath, { question_id: selected.question_id, policy,
          page_number: pageNumber, source_offset: retained, prior_pool_id: poolId }, meter, config.limits.max_output_bytes);
        attemptEvidence.push({ page_number: pageNumber, started: startedRef, result: null, page: null });
        attemptPaths.push(startedPath); attemptedPages++; meter.attempts++; pendingAttempt = true;
        const pageStarted = performance.now();
        const response = SoulInterpretationPrepareQueryResponseSchema.parse(await callMcpTool(daemon.mcpClient,
          "soul.interpretation", SoulInterpretationRequestSchema.parse({ operation: "prepare_query",
            original_query: selected.question, budget: config.budget, access_policy: policy,
            authorized_scopes: plan.config.authorized_scopes,
            ...(continuation === undefined ? {} : { continuation_handle: continuation }) })));
        const page: NativePage = { response, wall_ms: performance.now() - pageStarted };
        const resultPath = `${attemptBase}.result.json`;
        const resultRef = writeMeasuredArtifact(root, resultPath, { question_id: selected.question_id, policy,
          page_number: pageNumber, work: response.work, execution: response.execution,
          provider_attempts: sourceSemanticExecutionExternalAttempts(response.execution),
          response_identity: chainIdentity(JSON.parse(JSON.stringify(response))), wall_ms: page.wall_ms },
        meter, config.limits.max_output_bytes);
        attemptEvidence[pageNumber]!.result = resultRef;
        attemptPaths.push(resultPath); settledPages++; meter.settled++; pendingAttempt = false;
        if (response.work.logical_work !== undefined) {
          meter.work += response.work.logical_work; logicalWork += response.work.logical_work;
          if (pageNumber === 0) initialLogicalWork += response.work.logical_work;
          else continuationLogicalWork += response.work.logical_work;
        } else { unresolvedAttempts++; meter.unresolved++; }
        nativeWork += response.work.native_work; nativeBytes += response.work.native_bytes;
        const access = response.access;
        if (response.work.logical_work === undefined || access === undefined || access.policy !== policy || access.trace.kind !== "preparation_page"
          || access.trace.source_offset !== retained || response.query_handle === undefined
          || response.query_semantics_status.status !== "unavailable" || response.query_semantics_status.reason !== "absent"
          || response.query_semantics_id !== undefined || response.candidates.length !== 0
          || response.outcome?.status !== "preparation_required" || response.outcome.missing !== "query_semantics"
          || poolId !== null && access.pool_id !== poolId || inputId !== null && access.input_id !== inputId
          || observed !== null && access.observed_source_count !== observed) {
          throw new AlayaError("CONFLICT", "native raw-source access page changed identity, order or semantic state");
        }
        if (access.observed_source_count > memberIds.size ||
          access.source_candidates.some((candidate) => !memberIds.has(candidate.source_id)) ||
          retained + access.source_candidates.length > access.observed_source_count ||
          retained < access.observed_source_count && access.source_candidates.length === 0 ||
          access.source_candidates.some((candidate) => seen.has(candidate.source_id))) {
          throw new AlayaError("CONFLICT", "native source access page did not advance");
        }
        const pagePath = join("pages", String(selected.index).padStart(5, "0"), policy, `${String(pageNumber).padStart(3, "0")}.json`);
        const retainedPage = JSON.parse(JSON.stringify(page));
        if (meter.outputBytes + payloadByteSize(retainedPage) + meter.summaryReserveBytes > config.limits.max_output_bytes) {
          meter.stop = "output_bytes_limit"; reason = meter.stop; break;
        }
        // MCP response schemas may retain optional undefined fields; the durable JSON identity binds serialized bytes.
        attemptEvidence[pageNumber]!.page = writeMeasuredArtifact(root, pagePath, retainedPage,
          meter, config.limits.max_output_bytes);
        poolId = access.pool_id; inputId = access.input_id; observed = access.observed_source_count;
        for (const candidate of access.source_candidates) seen.add(candidate.source_id);
        paths.push(pagePath); meter.pages++;
        sourceReadBytes += access.source_candidates.reduce((sum, candidate) => sum + candidate.read_bytes, 0);
        incompleteBodies += access.source_candidates.filter((candidate) => !candidate.complete).length;
        for (const stop of access.stopping_reasons) stoppingReasons.add(stop);
        retained += access.source_candidates.length; unvisited = access.unvisited_sources;
        if (retained === observed) { status = "observed"; break; }
        continuation = response.continuation_handle;
        if (continuation === undefined) { reason = "native_source_continuation_unavailable"; break; }
        if (continuations.has(continuation)) throw new AlayaError("CONFLICT", "native source continuation repeated");
        continuations.add(continuation);
      }
      if (status !== "observed" && reason === null) reason = "source_page_cap";
      sampleDisk(root, meter);
    });
  } catch (error) {
    sampleDisk(root, meter);
    if (pendingAttempt) { unresolvedAttempts++; meter.unresolved++; }
    status = attemptedPages === 0 ? "failed" : "partial";
    reason = `native_access: ${reasonOf(error)}`;
    meter.stop = reason;
  }
  if (meter.stop === null) meter.stop = reachedLimit(config, root, meter);
  if (status === "partial" && attemptedPages === 0) status = "unattempted";
  return SourceAccessDiagnosticRowSchema.parse({ question_id: selected.question_id, index: selected.index,
    policy, status, reason, page_paths: paths, attempt_paths: attemptPaths,
    attempt_evidence: attemptEvidence,
    attempted_pages: attemptedPages, settled_pages: settledPages, unresolved_attempts: unresolvedAttempts,
    pool_id: poolId, observed_source_count: observed, retained_source_count: retained, unvisited_sources: unvisited,
    unretained_observed_sources: observed === null ? null : observed - retained,
    incomplete_source_bodies: incompleteBodies, source_read_bytes: sourceReadBytes,
    stopping_reasons: [...stoppingReasons], initial_logical_work: initialLogicalWork,
    continuation_logical_work: continuationLogicalWork,
    native_work: nativeWork, logical_work: logicalWork, native_bytes: nativeBytes,
    wall_ms: performance.now() - started });
}

/** Reserve the known SQLite restore copy before its lifecycle owner creates the session. */
function admitSession(config: SourceAccessDiagnosticConfig, root: string,
  plan: ReturnType<typeof SemanticChainPlanSchema.parse>, slot: number, meter: RunMeter): string | null {
  const limit = reachedLimit(config, root, meter, slot);
  if (limit !== null) { meter.stop = limit; return limit; }
  const snapshotBytes = statSync(plan.config.snapshot_path).size;
  meter.admissionSnapshotBytes = Math.max(meter.admissionSnapshotBytes ?? 0, snapshotBytes);
  const current = sampleDisk(root, meter);
  const nextAttempts = meter.admittedAttempts.map((count, position) => position === slot ? count + 1 : count);
  const reserve = Math.max(meter.summaryReserveBytes, summaryReservation(config, nextAttempts));
  if (current + snapshotBytes + reserve <= config.limits.max_disk_bytes) return null;
  meter.diskBytesAtStop = current;
  meter.stop = "disk_bytes_limit_before_session";
  return meter.stop;
}

function reachedLimit(config: SourceAccessDiagnosticConfig, root: string, meter: RunMeter, slot?: number): string | null {
  if (meter.pages >= config.limits.max_pages) return "page_limit";
  // The native request budget is the maximum charge for the next page.
  if (meter.work + config.budget.work_units > config.limits.max_total_work) return "logical_work_limit";
  if (performance.now() - meter.started >= config.limits.max_wall_ms) return "wall_time_limit";
  const nextAttempts = slot === undefined ? meter.admittedAttempts :
    meter.admittedAttempts.map((count, position) => position === slot ? count + 1 : count);
  const reserve = slot === undefined ? meter.summaryReserveBytes :
    Math.max(meter.summaryReserveBytes, summaryReservation(config, nextAttempts));
  if (meter.outputBytes + ATTEMPT_RESERVE_BYTES + reserve > config.limits.max_output_bytes) return "output_bytes_limit";
  const diskBytes = sampleDisk(root, meter);
  if (diskBytes + reserve > config.limits.max_disk_bytes) {
    meter.diskBytesAtStop = diskBytes;
    return "disk_bytes_limit";
  }
  return null;
}

function sampleDisk(root: string, meter: RunMeter): number {
  const bytes = directoryBytes(root) + (meter.sourceDiskBytes ?? 0);
  meter.diskPeakBytes = Math.max(meter.diskPeakBytes, bytes);
  return bytes;
}

function payloadByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ identity: chainIdentity(value), payload: value }));
}

function writeMeasuredArtifact(root: string, path: string, value: unknown,
  meter: RunMeter, maxOutputBytes: number): SourceAccessArtifactRef {
  const payload = JSON.parse(JSON.stringify(value));
  if (meter.outputBytes + payloadByteSize(payload) + meter.summaryReserveBytes > maxOutputBytes) {
    throw new AlayaError("RESOURCE_EXHAUSTED", "diagnostic artifact exceeds retained output bound");
  }
  const absolute = join(root, path);
  writeChainArtifact(absolute, payload);
  meter.outputBytes += statSync(absolute).size;
  return { path, identity: chainIdentity(payload) };
}

function directoryBytes(root: string): number {
  let bytes = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new AlayaError("CONFLICT", "diagnostic output contains a symlink");
    bytes += stat.isDirectory() ? directoryBytes(path) : stat.size;
  }
  return bytes;
}

function emptyRow(questionId: string, index: number | null, policy: SourceAccessDiagnosticConfig["policies"][number],
  status: "failed" | "unattempted", reason: string): SourceAccessDiagnosticRow {
  return SourceAccessDiagnosticRowSchema.parse({ question_id: questionId, index, policy, status, reason,
    page_paths: [], attempt_paths: [], attempt_evidence: [],
    attempted_pages: 0, settled_pages: 0, unresolved_attempts: 0,
    pool_id: null, observed_source_count: null, retained_source_count: 0,
    unretained_observed_sources: null, unvisited_sources: null, incomplete_source_bodies: 0,
    source_read_bytes: 0, stopping_reasons: [], initial_logical_work: 0,
    continuation_logical_work: 0, native_work: 0, logical_work: 0, native_bytes: 0, wall_ms: 0 });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, REASON_LIMIT) : String(error).slice(0, REASON_LIMIT);
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
