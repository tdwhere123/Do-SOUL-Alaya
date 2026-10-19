import { currentBenchScope, trackBenchOperation, refuseBenchWorkAfterCancel } from "../../harness/daemon-task.js";
import { basename, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { z } from "zod";
import { AlayaError, canonicalJson, SoulInterpretationResponseSchema,
  type SourceRecordIdentity, type SoulInterpretationResponse } from "@do-soul/alaya-protocol";
import { callMcpTool, type BenchMcpToolCapture } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { recordSourceSemanticLibraryFirstExposure } from "../measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse } from "../measurement/source-semantic-library-measurement.js";
import { admitEvaluatorOutputRoot } from "../measurement/evaluator-output.js";
import { sourceLookupStores } from "../snapshot/source-records/publish.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import { FirstExposurePageSchema, type FirstExposureSession } from "../measurement/first-exposure-session.js";
import { admitDeliveredSources, admitSemanticChainLibraryBinding, sameSealedSnapshotObservation,
  semanticChainLibraryRecallRequest } from "./library-admission.js";
import { SemanticChainPlanSchema, SemanticChainQuerySchema, chainIdentity, readChainArtifact, writeChainArtifact,
  assertChainSnapshot, withSemanticChainDaemon, type SemanticChainPlan } from "./contract.js";
import { readSemanticChainCorrespondences, semanticChainQueryCorrespondences, verifySemanticChainQueries } from "./inputs.js";
import { semanticChainCacheInputPaths } from "./inputs.js";
import { discoverSemanticChainQuery } from "./prepare.js";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import type { SemanticChainConfig } from "./contract.js";
import { SemanticChainSourceFailureSchema, SemanticChainSourceObservationError,
  type SemanticChainSourceFailure } from "./source-index-observation.js";

export function inspectSemanticChainReplayTarget(root: string, arm: "retained" | "without_semantic_correspondences") {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const config = plan.config;
  assertChainSnapshot(config);
  verifySemanticChainQueries(plan);
  const { semantic_correspondences, identity } = readSemanticChainCorrespondences(plan, arm);
  const output = semanticChainReplayPath(root, identity);
  return { plan, config, semantic_correspondences, identity, output,
    rowPaths: new Map(plan.queries.map(query => [query.query_key,
      semanticChainReplayRowPath(root, identity, query.query_key)])) };
}

function semanticChainReplayPath(root: string, identity: string): string {
  return join(root, `replay-${identity}.json`);
}

function semanticChainReplayRowPath(root: string, identity: string, queryKey: string): string {
  return join(root, `replay-${identity}`, `${queryKey}.json`);
}

export async function replaySemanticChain(root: string, arm: "retained" | "without_semantic_correspondences" = "retained",
  expectedIdentity?: string) {
  const scope = currentBenchScope();
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    const { plan, config, semantic_correspondences, identity, output, rowPaths } = inspectSemanticChainReplayTarget(root, arm);
    if (expectedIdentity !== undefined && identity !== expectedIdentity) {
      throw new AlayaError("CONFLICT", "frozen replay correspondence identity changed");
    }
    return withSnapshotPublishLock(output, async () => {
      const retained = readChainArtifact(output);
      if (retained !== undefined) return { path: output, result: retained };
      const rows: unknown[] = [];
      if (plan.queries.every((query) => query.status === "blocked")) rows.push(...plan.queries);
      else await withSemanticChainDaemon(config, root, async (daemon) => {
        for (const query of plan.queries) {
          if (query.status === "blocked") { rows.push(query); continue; }
          const { ready, outcomes } = query.status === "ready"
            ? semanticChainQueryCorrespondences(query, semantic_correspondences) : { ready: [], outcomes: [] };
          const rowPath = rowPaths.get(query.query_key)!;
          const prior = readChainArtifact(rowPath);
          if (prior !== undefined) { rows.push(prior); continue; }
          const row = await executeSemanticChainQuery({ daemon, config, query,
            ready: arm === "retained" ? ready : [], outcomes, rowPath, replayIdentity: identity });
          rows.push(row);
        }
      });
      refuseBenchWorkAfterCancel();
      const result = semanticChainReplayAggregate(plan, identity, arm, rows);
      writeChainArtifact(output, result);
      return { path: output, result };
    });
  };
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

function semanticChainReplayAggregate(plan: SemanticChainPlan, identity: string,
  arm: "retained" | "without_semantic_correspondences", rows: readonly unknown[]) {
  return { contract: "source-semantic-chain-replay-v3", plan_identity: chainIdentity(plan),
    identity, arm, provider_calls: 0, rows };
}

/** After a crash past the immutable response row, close the replay archive without observing again. */
export async function closeSemanticChainReplayFromDurableRows(root: string,
  arm: "retained" | "without_semantic_correspondences" = "retained") {
  const scope = currentBenchScope();
  const operation = async () => {
    refuseBenchWorkAfterCancel();
    const { plan, identity, output, rowPaths } = inspectSemanticChainReplayTarget(root, arm);
    return withSnapshotPublishLock(output, async () => {
      const prior = readChainArtifact(output);
      if (prior !== undefined) return { path: output, result: ReplaySchema.parse(prior) };
      const rows: unknown[] = [];
      for (const query of plan.queries) {
        if (query.status === "blocked") { rows.push(query); continue; }
        const rowPath = rowPaths.get(query.query_key)!;
        const row = readChainArtifact(rowPath);
        if (row === undefined) return null;
        const reservation = readChainArtifact(`${rowPath}.reserved`);
        if (canonicalJson(reservation) !== canonicalJson({ replay_identity: identity, query_key: query.query_key })) {
          throw new AlayaError("CONFLICT", "durable native response row lacks its exact exposure reservation");
        }
        rows.push(row);
      }
      const result = ReplaySchema.parse(semanticChainReplayAggregate(plan, identity, arm, rows));
      writeChainArtifact(output, result);
      return { path: output, result };
    });
  };
  return scope === undefined ? operation() : trackBenchOperation(scope, operation);
}

type LibraryCaptureHooks = Readonly<{
  beforeRequest?: (request: Record<string, unknown>) => void;
  capture?: (frame: BenchMcpToolCapture) => void;
  exposureSession?: FirstExposureSession;
}>;

/** Reserve and prepare exactly once; all native library launchers use this execution phase. */
export async function executeSemanticChainQuery(input: Omit<Parameters<typeof deliverPreparedSemanticChainQuery>[0],
  "prepared" | "preparationElapsed" | "preparationError" | "preparationFailure" | "started">) {
  refuseBenchWorkAfterCancel();
  const { daemon, config, query, rowPath, replayIdentity } = input;
  const reservation = `${rowPath}.reserved`;
  if (readChainArtifact(reservation) !== undefined) {
    throw new AlayaError("CONFLICT", "native first exposure is unresolved after interruption; retained reservation forbids re-exposure");
  }
  writeChainArtifact(reservation, { replay_identity: replayIdentity, query_key: query.query_key });
  const started = performance.now();
  let prepared: Awaited<ReturnType<typeof discoverSemanticChainQuery>> | undefined;
  let preparationError: string | null = null;
  let preparationFailure: SemanticChainSourceFailure | undefined;
  try { prepared = await discoverSemanticChainQuery(daemon, config, query.original_query,
    query.status === "ready" ? query.query_semantics : undefined,
    query.status === "raw_ready" && query.query_semantics_unavailable !== "absent"
      ? query.query_semantics_unavailable : undefined); }
  catch (error) {
    refuseBenchWorkAfterCancel();
    if (error instanceof AlayaError && error.code === "CANCELLED") throw error;
    preparationError = error instanceof Error ? error.message : String(error);
    if (error instanceof SemanticChainSourceObservationError) preparationFailure = error.failure;
  }
  return deliverPreparedSemanticChainQuery({ ...input, prepared, preparationElapsed: performance.now() - started,
    preparationError, preparationFailure, started });
}

/** Native replay and guarded local-index measurement share one first-exposure owner. */
export async function deliverPreparedSemanticChainQuery(input: Readonly<{
  daemon: BenchDaemonHandle; config: SemanticChainConfig;
  query: Exclude<SemanticChainPlan["queries"][number], { status: "blocked" }>;
  prepared: Awaited<ReturnType<typeof discoverSemanticChainQuery>> | undefined;
  ready: ReturnType<typeof semanticChainQueryCorrespondences>["ready"];
  outcomes: ReturnType<typeof semanticChainQueryCorrespondences>["outcomes"];
  rowPath: string; replayIdentity: string; preparationElapsed: number;
  preparationError: string | null; preparationFailure?: SemanticChainSourceFailure; started: number;
}> & LibraryCaptureHooks) {
  refuseBenchWorkAfterCancel();
  const { daemon, config, query, prepared, ready, outcomes, rowPath, replayIdentity,
    preparationElapsed, preparationError, started } = input;
  const reservation = readChainArtifact(`${rowPath}.reserved`);
  if (canonicalJson(reservation) !== canonicalJson({ replay_identity: replayIdentity, query_key: query.query_key })) {
    throw new AlayaError("CONFLICT", "native delivery lacks its exact prior exposure reservation");
  }
  if (prepared?.query_handle === undefined || !sameSealedSnapshotObservation(query, prepared.discovery)) {
    const row = { query_key: query.query_key, status: "native_unavailable", reason: prepared === undefined ? "preparation_unavailable"
      : prepared.query_handle === undefined ? "handle_unavailable" : "prepared_access_pool_mismatch",
      correspondence_outcomes: outcomes, first_exposure: null,
      preparation_trace: prepared?.discovery.discovery_trace ?? null, preparation_error: preparationError,
      ...(input.preparationFailure === undefined ? {} : { preparation_failure: input.preparationFailure }),
      preparation_elapsed_ms: preparationElapsed, native_elapsed_ms: performance.now() - started };
    writeChainArtifact(rowPath, row);
    return row;
  }
  const poolId = prepared.discovery.discovery_trace.at(-1)!.access.pool_id;
  const request = semanticChainLibraryRecallRequest(config, query, ready, prepared.query_handle);
  input.beforeRequest?.(structuredClone(request));
  const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation", request, input.capture));
  refuseBenchWorkAfterCancel();
  if (response.operation !== "recall") throw new AlayaError("INTERNAL", "native recall returned a different operation");
  if (response.query_semantics_status !== undefined &&
    canonicalJson(response.query_semantics_status) !== canonicalJson(prepared.discovery.discovery_trace.at(-1)?.query_semantics_status)) {
    throw new AlayaError("CONFLICT", "native recall changed prepared query semantic availability");
  }
  if (response.index !== undefined && (response.discovery?.access?.policy !== config.access_policy
    || response.discovery.access.pool_id !== poolId)) {
    throw new AlayaError("CONFLICT", "native recall did not bind the prepared access pool");
  }
  const exposure = response.index === undefined || response.delivery_id === undefined ? null
    : recordSourceSemanticLibraryFirstExposure(response, input.exposureSession);
  const row = { query_key: query.query_key, status: exposure === null ? "native_unavailable" : "replayed",
    correspondence_outcomes: outcomes, response, first_exposure: exposure,
    preparation_trace: prepared.discovery.discovery_trace, preparation_elapsed_ms: preparationElapsed,
    native_elapsed_ms: performance.now() - started };
  writeChainArtifact(rowPath, row);
  return row;
}

export function measureSemanticChain(root: string, replayPath: string, goldValue: unknown, evaluatorRoot: string) {
  const { plan, replay, admittedInputPaths } = admitSemanticChainReplay(root, replayPath);
  const outputRoot = admitEvaluatorOutputRoot(evaluatorRoot, [root, ...admittedInputPaths,
    plan.config.snapshot_path, ...semanticChainCacheInputPaths(plan)]);
  const gold = z.array(z.object({ query_key: z.string(), source_units: SourceGoldUnitSchema.array() }).strict()).parse(goldValue);
  const expected = plan.queries.map((row) => row.query_key).sort();
  if (canonicalJson(expected) !== canonicalJson(gold.map((row) => row.query_key).sort())) {
    throw new AlayaError("VALIDATION", "measurement requires exact per-query gold and replay denominator coverage");
  }
  const rows = replay.rows.map((row) => {
    const prepared = plan.queries.find((query) => query.query_key === row.query_key)!;
    const evaluated = row.status !== "replayed" || row.first_exposure == null ? null : measureSourceSemanticLibraryResponse({
      recallResult: row.response, firstExposurePage: row.first_exposure,
      requestBudget: plan.config.budget, sourceRecords: row.source_records,
      goldSourceUnits: gold.find((entry) => entry.query_key === row.query_key)!.source_units
    });
    return { query_key: row.query_key, status: row.status,
    query_failure_reason: prepared.status === "raw_ready" ? prepared.reason : null,
    reason: row.reason ?? (evaluated?.sourceBearingUnion?.any_at_5.status === "unavailable"
      ? evaluated.sourceBearingUnion.any_at_5.reason : null),
    mechanism: { status: (evaluated?.validatedProofRanks.length ?? 0) > 0 ? "proof_exercised" : "unexercised",
      reason: row.status === "blocked" ? row.reason : row.status === "native_unavailable" ? "native_unavailable"
        : prepared.status === "raw_ready" ? prepared.reason
        : (evaluated?.validatedProofRanks.length ?? 0) > 0 ? null : "no_validated_delivered_proof",
      validated_proof_ranks: evaluated?.validatedProofRanks ?? [],
      source_interpretation_candidates: prepared.status === "blocked" ? 0 : prepared.descriptors.length,
      correspondence_opportunities: prepared.status === "ready" ? prepared.correspondence_opportunities : [],
      ...(prepared.status === "ready" && prepared.correspondence_demand_opportunities !== undefined
        ? { correspondence_demand_opportunities: prepared.correspondence_demand_opportunities } : {}),
      correspondence_outcomes: row.correspondence_outcomes ?? null },
    preparation_trace: row.preparation_trace ?? null, preparation_elapsed_ms: row.preparation_elapsed_ms ?? null,
    ...(row.discovery_failure === undefined ? {} : { discovery_failure: row.discovery_failure }),
    ...(row.preparation_failure === undefined ? {} : { preparation_failure: row.preparation_failure }),
    diagnostics: row.response?.operation === "recall" ? {
      order: row.response.order, discovery: row.response.discovery, coverage: row.response.coverage,
      query_semantics_status: row.response.query_semantics_status, work: row.response.work,
      delivered_results: row.response.results?.length ?? 0, delivered_proofs: row.response.proofs?.length ?? 0,
      native_elapsed_ms: row.native_elapsed_ms ?? null
    } : null,
    measurement: evaluated?.measurement ?? null, source_bearing_union: evaluated?.sourceBearingUnion ?? null,
    evaluator_usage: evaluated?.evaluator_usage ?? null };
  });
  const result = { contract: "source-semantic-chain-measurement-v3", replay_identity: replay.identity, gold, rows };
  const path = join(outputRoot, `measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result);
  return { path, result };
}

// Keep declaration inference at the public value boundary, not the nested Zod graph.
const ReplayResponseSchema: z.ZodType<SoulInterpretationResponse> = SoulInterpretationResponseSchema;
export const ReplaySchema = z.object({ contract: z.literal("source-semantic-chain-replay-v3"),
  plan_identity: z.string(), identity: z.string(), arm: z.enum(["retained", "without_semantic_correspondences"]), provider_calls: z.literal(0),
  rows: z.array(z.object({ query_key: z.string(), status: z.enum(["blocked", "replayed", "native_unavailable"]),
    reason: z.string().optional(), native_elapsed_ms: z.number().nonnegative().optional(),
    preparation_elapsed_ms: z.number().nonnegative().optional(),
    discovery_failure: SemanticChainSourceFailureSchema.optional(), preparation_failure: SemanticChainSourceFailureSchema.optional(),
    response: ReplayResponseSchema.optional(), first_exposure: FirstExposurePageSchema.nullable().optional(),
    correspondence_outcomes: z.array(z.object({ key: z.string().nullable(), raw_digest: z.string().nullable() }).passthrough()).optional(),
    preparation_trace: SemanticChainQuerySchema.options[1].shape.discovery_trace.nullable().optional()
  }).passthrough()) }).passthrough();
type ReplayRow = z.infer<typeof ReplaySchema>["rows"][number];

/** Physical replay inputs are known from the frozen path and query keys, even if the plan or replay is unavailable. */
export function semanticChainReplayInputPaths(root: string, replayPath: string, queryKeys: readonly string[]): readonly string[] {
  const paths = [join(root, "prepare.json"), replayPath];
  const match = /^replay-([a-f0-9]{64})\.json$/u.exec(basename(replayPath));
  if (resolve(replayPath) !== resolve(root, basename(replayPath)) || match === null) return paths;
  return [...paths, ...queryKeys.flatMap(key => {
    const path = semanticChainReplayRowPath(root, match[1]!, key);
    return [path, `${path}.reserved`];
  })];
}

/** All archive consumers re-admit frozen inputs and native delivery before using retained results. */
export function admitSemanticChainReplay(root: string, replayPath: string) {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const replay = ReplaySchema.parse(readChainArtifact(replayPath));
  if (resolve(replayPath) !== resolve(semanticChainReplayPath(root, replay.identity))) {
    throw new AlayaError("CONFLICT", "measurement replay path does not bind its retained identity");
  }
  if (replay.plan_identity !== chainIdentity(plan)) {
    throw new AlayaError("CONFLICT", "measurement replay does not bind this plan");
  }
  const expected = plan.queries.map((row) => row.query_key).sort();
  if (canonicalJson(expected) !== canonicalJson(replay.rows.map((row) => row.query_key).sort())) {
    throw new AlayaError("CONFLICT", "archive requires exact query denominator coverage");
  }
  assertChainSnapshot(plan.config);
  verifySemanticChainQueries(plan);
  const retained = readSemanticChainCorrespondences(plan, replay.arm);
  if (retained.identity !== replay.identity) throw new AlayaError("CONFLICT", "retained native semantic-correspondence state changed");
  const connection = new BetterSqlite3(plan.config.snapshot_path, { readonly: true, fileMustExist: true });
  try {
    connection.pragma("query_only = ON");
    const database = new StorageDatabase(plan.config.snapshot_path, connection);
    const stores = sourceLookupStores(database);
    const reader = new SqliteSourceHintReader(connection);
    const rows = replay.rows.map((row) => {
      try {
        const source_records = admitReplayRow(root, plan, replay, row, retained.semantic_correspondences, stores, reader);
        return { ...row, source_records };
      } catch (error) {
        return { ...row, status: "native_unavailable" as const, source_records: [],
          reason: `archive_admission: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
    return { plan, replay: { ...replay, rows }, admittedInputPaths: semanticChainReplayInputPaths(root, replayPath,
      replay.rows.map(row => row.query_key)) };
  } finally { connection.close(); }
}

function admitReplayRow(root: string, plan: SemanticChainPlan, replay: z.infer<typeof ReplaySchema>, row: ReplayRow,
  correspondences: ReturnType<typeof readSemanticChainCorrespondences>["semantic_correspondences"],
  stores: ReturnType<typeof sourceLookupStores>, reader: SqliteSourceHintReader): SourceRecordIdentity[] {
  const query = plan.queries.find((entry) => entry.query_key === row.query_key)!;
  const delivered = row.response?.operation === "recall" && row.response.index !== undefined;
  if (query.status === "blocked") {
    if (row.status !== "blocked" || row.reason !== query.reason || row.first_exposure != null || delivered ||
        canonicalJson(row.discovery_failure ?? null) !== canonicalJson(query.discovery_failure ?? null)) {
      throw new AlayaError("CONFLICT", "blocked query cannot have a native delivery");
    }
    return [];
  }
  if (row.status === "blocked") throw new AlayaError("CONFLICT", "ready query cannot become a blocked archive row");
  const rowPath = semanticChainReplayRowPath(root, replay.identity, row.query_key);
  const retainedRow = readChainArtifact(rowPath), reservation = readChainArtifact(`${rowPath}.reserved`);
  if (retainedRow === undefined || reservation === undefined || canonicalJson(retainedRow) !== canonicalJson(row)
    || canonicalJson(reservation) !== canonicalJson({ replay_identity: replay.identity, query_key: row.query_key })) {
    throw new AlayaError("CONFLICT", "native row or first-exposure reservation differs from retained replay");
  }
  if (row.status === "native_unavailable") {
    if (row.first_exposure != null || delivered) throw new AlayaError("CONFLICT", "unavailable row cannot have a native delivery");
    return [];
  }
  const response = row.response;
  if (response?.operation !== "recall" || response.index === undefined || row.first_exposure == null) {
    throw new AlayaError("CONFLICT", "replayed row requires its native initial delivery");
  }
  const { config } = plan;
  const { ready, outcomes } = query.status === "ready"
    ? semanticChainQueryCorrespondences(query, correspondences) : { ready: [], outcomes: [] };
  const selected = replay.arm === "retained" ? ready : [];
  if (canonicalJson(row.correspondence_outcomes) !== canonicalJson(outcomes)) {
    throw new AlayaError("CONFLICT", "native delivery belongs to another frozen request");
  }
  const scopes = admitSemanticChainLibraryBinding(config, query, response, selected, row.preparation_trace);
  return admitDeliveredSources(config, response, stores, reader, scopes, selected);
}
