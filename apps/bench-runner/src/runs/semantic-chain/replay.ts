import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { admitSourceSemanticQuery, authorizedScopesFromAdmission, authorizeSemanticScope, fieldContractSha256, hydrateUtf8Chunk, preparedDeliveryId,
  proofForLibraryEntry, resolveCurrentSource,
  sourceSemanticQueryStatus,
  semanticInterpretationEvidenceId, sourceSemanticAccessInputIdentity, sourceSemanticLibraryQueryIdentity,
  sourceSemanticLibraryRequestIdentity, verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { z } from "zod";
import { AlayaError, canonicalJson, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  sourceEvidenceRootTarget, sourceRecallTarget, type MemorySearchResult, type SourceEvidenceTarget,
  type SourceSemanticLibrarySlotQualifier,
  type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { recordSourceSemanticLibraryFirstExposure } from "../measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse } from "../measurement/source-semantic-library-measurement.js";
import { sourceLookupStores } from "../snapshot/source-records/publish.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import { FirstExposurePageSchema } from "../measurement/first-exposure-session.js";
import { SemanticChainPlanSchema, SemanticChainQuerySchema, chainIdentity, readChainArtifact, writeChainArtifact,
  assertChainSnapshot, withSemanticChainDaemon, type SemanticChainPlan } from "./contract.js";
import { readSemanticChainCorrespondences, semanticChainQueryCorrespondences, verifySemanticChainQueries } from "./inputs.js";
import { discoverSemanticChainQuery } from "./prepare.js";

export function inspectSemanticChainReplayTarget(root: string, arm: "retained" | "without_semantic_correspondences") {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const config = plan.config;
  assertChainSnapshot(config);
  verifySemanticChainQueries(plan);
  const { semantic_correspondences, identity } = readSemanticChainCorrespondences(plan, arm);
  const output = semanticChainReplayPath(root, identity);
  return { plan, config, semantic_correspondences, identity, output,
    rowPaths: new Map(plan.queries.map(query => [query.query_key,
      join(root, `replay-${identity}`, `${query.query_key}.json`)])) };
}

export function semanticChainReplayPath(root: string, identity: string): string {
  return join(root, `replay-${identity}.json`);
}

export async function replaySemanticChain(root: string, arm: "retained" | "without_semantic_correspondences" = "retained",
  expectedIdentity?: string) {
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
        const reservation = `${rowPath}.reserved`;
        if (readChainArtifact(reservation) !== undefined) {
          throw new AlayaError("CONFLICT", "native first exposure is unresolved after interruption; retained reservation forbids re-exposure");
        }
        writeChainArtifact(reservation, { replay_identity: identity, query_key: query.query_key });
        const started = performance.now();
        let prepared: Awaited<ReturnType<typeof discoverSemanticChainQuery>> | undefined;
        let preparationError: string | null = null;
        try { prepared = await discoverSemanticChainQuery(daemon, config, query.original_query,
          query.status === "ready" ? query.query_semantics : undefined,
          query.status === "raw_ready" && query.query_semantics_unavailable !== "absent"
            ? query.query_semantics_unavailable : undefined); }
        catch (error) { preparationError = error instanceof Error ? error.message : String(error); }
        const preparationElapsed = performance.now() - started;
        if (prepared?.query_handle === undefined || !sameSealedSnapshotObservation(query, prepared.discovery)) {
          const row = { query_key: query.query_key, status: "native_unavailable", reason: prepared === undefined ? "preparation_unavailable"
            : prepared.query_handle === undefined ? "handle_unavailable" : "prepared_access_pool_mismatch",
            correspondence_outcomes: outcomes, first_exposure: null,
            preparation_trace: prepared?.discovery.discovery_trace ?? null, preparation_error: preparationError,
            preparation_elapsed_ms: preparationElapsed,
            native_elapsed_ms: performance.now() - started };
          writeChainArtifact(rowPath, row); rows.push(row); continue;
        }
        const poolId = prepared.discovery.discovery_trace.at(-1)!.access.pool_id;
        const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
          SoulInterpretationRequestSchema.parse({ operation: "recall", original_query: query.original_query,
            ...(query.status === "ready" ? { query_semantics: query.query_semantics }
              : query.query_semantics_unavailable === "absent" ? {} : { query_semantics_unavailable: query.query_semantics_unavailable }),
            query_handle: prepared.query_handle,
            semantic_correspondences: arm === "retained" ? ready : [], accepts_unreviewed_conditional_results: true,
            budget: config.budget, output_byte_limit: config.output_byte_limit, authorized_scopes: config.authorized_scopes,
            access_policy: config.access_policy })));
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
          : recordSourceSemanticLibraryFirstExposure(response);
        const row = { query_key: query.query_key, status: exposure === null ? "native_unavailable" : "replayed",
          correspondence_outcomes: outcomes, response, first_exposure: exposure,
          preparation_trace: prepared.discovery.discovery_trace, preparation_elapsed_ms: preparationElapsed,
          native_elapsed_ms: performance.now() - started };
        writeChainArtifact(rowPath, row); rows.push(row);
      }
    });
    const result = { contract: "source-semantic-chain-replay-v3", plan_identity: chainIdentity(plan),
      identity, arm, provider_calls: 0, rows };
    writeChainArtifact(output, result);
    return { path: output, result };
  });
}

/** Replay of the same sealed SQLite under the existing snapshot/revision guards, not general cross-library equivalence.
 * Native pool_id includes SQLite connection-local revisions; every other observed receipt field and descriptor must match. */
function sameSealedSnapshotObservation(expected: Awaited<ReturnType<typeof discoverSemanticChainQuery>>["discovery"],
  actual: Awaited<ReturnType<typeof discoverSemanticChainQuery>>["discovery"]): boolean {
  const comparable = (value: typeof actual) => ({ descriptors: value.descriptors,
    access: value.discovery_trace.map(({ access: { pool_id: _connectionPoolId, ...observation } }) => observation) });
  return canonicalJson(comparable(expected)) === canonicalJson(comparable(actual));
}

export function measureSemanticChain(root: string, replayPath: string, goldValue: unknown) {
  const { plan, replay } = admitSemanticChainReplay(root, replayPath);
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
      correspondence_outcomes: row.correspondence_outcomes ?? null },
    preparation_trace: row.preparation_trace ?? null, preparation_elapsed_ms: row.preparation_elapsed_ms ?? null,
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
  const path = join(root, `measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result);
  return { path, result };
}

export const ReplaySchema = z.object({ contract: z.literal("source-semantic-chain-replay-v3"),
  plan_identity: z.string(), identity: z.string(), arm: z.enum(["retained", "without_semantic_correspondences"]), provider_calls: z.literal(0),
  rows: z.array(z.object({ query_key: z.string(), status: z.enum(["blocked", "replayed", "native_unavailable"]),
    reason: z.string().optional(), native_elapsed_ms: z.number().nonnegative().optional(),
    preparation_elapsed_ms: z.number().nonnegative().optional(),
    response: SoulInterpretationResponseSchema.optional(), first_exposure: FirstExposurePageSchema.nullable().optional(),
    correspondence_outcomes: z.array(z.object({ key: z.string().nullable(), raw_digest: z.string().nullable() }).passthrough()).optional(),
    preparation_trace: SemanticChainQuerySchema.options[1].shape.discovery_trace.nullable().optional()
  }).passthrough()) }).passthrough();
type ReplayRow = z.infer<typeof ReplaySchema>["rows"][number];

/** All archive consumers re-admit frozen inputs and native delivery before using retained results. */
export function admitSemanticChainReplay(root: string, replayPath: string) {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const replay = ReplaySchema.parse(readChainArtifact(replayPath));
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
    return { plan, replay: { ...replay, rows } };
  } finally { connection.close(); }
}

function admitReplayRow(root: string, plan: SemanticChainPlan, replay: z.infer<typeof ReplaySchema>, row: ReplayRow,
  correspondences: ReturnType<typeof readSemanticChainCorrespondences>["semantic_correspondences"],
  stores: ReturnType<typeof sourceLookupStores>, reader: SqliteSourceHintReader): SourceRecordIdentity[] {
  const query = plan.queries.find((entry) => entry.query_key === row.query_key)!;
  const delivered = row.response?.operation === "recall" && row.response.index !== undefined;
  if (query.status === "blocked") {
    if (row.status !== "blocked" || row.reason !== query.reason || row.first_exposure != null || delivered) {
      throw new AlayaError("CONFLICT", "blocked query cannot have a native delivery");
    }
    return [];
  }
  if (row.status === "blocked") throw new AlayaError("CONFLICT", "ready query cannot become a blocked archive row");
  const rowPath = join(root, `replay-${replay.identity}`, `${row.query_key}.json`);
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
  const scopes = authorizedScopesFromAdmission(config.authorized_scopes).authorized_scopes;
  if (scopes === undefined) throw new AlayaError("CONFLICT", "native delivery requires explicit scope admission");
  const { ready, outcomes } = query.status === "ready"
    ? semanticChainQueryCorrespondences(query, correspondences) : { ready: [], outcomes: [] };
  const selected = replay.arm === "retained" ? ready : [];
  const querySemantics = query.status === "ready" ? query.query_semantics : undefined;
  const queryStatus = sourceSemanticQueryStatus(admitSourceSemanticQuery(querySemantics, query.original_query),
    query.status === "raw_ready" && query.query_semantics_unavailable !== "absent"
      ? query.query_semantics_unavailable : undefined);
  const expectedIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: config.workspace_id, as_of: config.interpretation_clock,
    authorized_scopes: scopes, original_query: query.original_query, query_semantics: querySemantics,
    query_semantics_status: queryStatus,
    semantic_correspondences: selected, budget: config.budget, output_byte_limit: config.output_byte_limit, access_policy: config.access_policy });
  if (response.request_identity !== expectedIdentity || response.index.query_id !== sourceSemanticLibraryQueryIdentity(query.original_query)
    || canonicalJson(response.query_semantics_status) !== canonicalJson(queryStatus)
    || response.index.as_of !== config.interpretation_clock || canonicalJson(response.request_budget) !== canonicalJson(config.budget)
    || canonicalJson(row.correspondence_outcomes) !== canonicalJson(outcomes)) throw new AlayaError("CONFLICT", "native delivery belongs to another frozen request");
  if (response.delivery_id !== preparedDeliveryId(expectedIdentity, response.index)) {
    throw new AlayaError("CONFLICT", "native delivery ID does not bind its frozen request and index");
  }
  const trace = row.preparation_trace;
  const access = response.discovery?.access;
  if (trace == null || trace.length === 0 || !sameSealedSnapshotObservation(query, { ...query, discovery_trace: trace })
    || access === undefined || access.pool_id !== trace.at(-1)!.access.pool_id || access.policy !== config.access_policy
    || access.input_id !== sourceSemanticAccessInputIdentity({ original_query: query.original_query, query_semantics: querySemantics,
      budget: config.budget, policy: config.access_policy })) throw new AlayaError("CONFLICT", "native delivery does not bind the prepared access pool");
  if (query.status === "raw_ready" && (response.proofs?.length ?? 0) > 0) {
    throw new AlayaError("CONFLICT", "unavailable query semantics cannot deliver a semantic proof");
  }
  return admitDeliveredSources(plan, response, stores, reader, scopes, selected);
}

function admitDeliveredSources(plan: SemanticChainPlan, response: Extract<z.infer<typeof SoulInterpretationResponseSchema>, { operation: "recall" }>,
  stores: ReturnType<typeof sourceLookupStores>, reader: SqliteSourceHintReader, scopes: readonly string[] | null,
  correspondences: ReturnType<typeof semanticChainQueryCorrespondences>["ready"]): SourceRecordIdentity[] {
  const records: SourceRecordIdentity[] = [];
  if (response.results?.length !== response.index!.entries.length) {
    throw new AlayaError("CONFLICT", "native delivery has no complete emitted source page");
  }
  for (const [position, entry] of response.index!.entries.entries()) {
    const target = entry.target;
    if (target.kind !== "source_evidence" || target.workspace_id !== plan.config.workspace_id) throw new AlayaError("CONFLICT", "native source workspace changed");
    const retained = stores.getStoredRecord(plan.config.workspace_id, target.root_id);
    if (retained === null) throw new AlayaError("CONFLICT", "delivered source is unavailable in sealed snapshot");
    const current = resolveCurrentSource(stores, plan.config.workspace_id, { artifact_key: retained.record.source_id,
      source_corpus_digest: target.content_digest.replace(/^sha256:/u, "") }, fieldContractSha256);
    authorizeSemanticScope(current.record.scope_class, scopes);
    if (canonicalJson(sourceEvidenceRootTarget(target)) !== canonicalJson(sourceRecallTarget({ workspace_id: current.record.workspace_id,
      root_kind: "source_record", root_id: current.record.identity, source_version: current.record.source_version,
      content_digest: current.record.content_digest, evidence_object_id: current.record.evidence_object_id }))) {
      throw new AlayaError("CONFLICT", "delivered source identity differs from current sealed source");
    }
    admitEmittedSourcePreview(target.span, response.results[position]!, response.slot_qualifiers?.[position],
      target, current.content_bytes, proofForLibraryEntry(entry, response.proofs ?? []) !== undefined);
    records.push(current.record);
  }
  for (const proof of response.proofs ?? []) {
    if (!correspondences.some((value) => canonicalJson(value) === canonicalJson(proof.semantic_correspondence))) {
      throw new AlayaError("CONFLICT", "delivered proof lacks its retained semantic correspondence");
    }
    const capsule = reader.readBoundInterpretation(plan.config.workspace_id,
      semanticInterpretationEvidenceId(proof.source_interpretation_id!, fieldContractSha256), 1_000_000);
    if (capsule.status !== "complete" || capsule.gist === null) throw new AlayaError("CONFLICT", "delivered interpretation is unavailable in sealed snapshot");
    const checked = verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256 }, JSON.parse(capsule.gist), plan.config.workspace_id);
    authorizeSemanticScope(checked.stored.record.scope_class, scopes);
    records.push(checked.stored.record);
  }
  return [...new Map(records.map((record) => [record.identity, record])).values()];
}

export function admitEmittedSourcePreview(span: SourceEvidenceTarget["span"], result: MemorySearchResult,
  qualifier: SourceSemanticLibrarySlotQualifier | undefined, target: SourceEvidenceTarget, source: string,
  requiresCompleteSupport: boolean): void {
  if (canonicalJson(result.target) !== canonicalJson(target)) {
    throw new AlayaError("CONFLICT", "emitted source target differs from delivered index");
  }
  if (span?.retained_extent !== "body") throw new AlayaError("CONFLICT", "emitted source has no bound body span");
  const full = hydrateUtf8Chunk(source, { offset: span.content_start, byteLimit: span.content_end - span.content_start });
  if (full.status !== "chunk" || full.end_offset !== span.content_end) {
    throw new AlayaError("CONFLICT", "emitted source span is not a UTF-8 slice of sealed source");
  }
  if (requiresCompleteSupport && (qualifier?.evidence_kind !== "semantic_proof"
    || qualifier.payload_support !== "available" || !result.budget_state.within_budget)) {
    throw new AlayaError("CONFLICT", "available proof support requires its complete emitted source preview");
  }
  if (result.content_preview === "[payload omitted]" && !result.budget_state.within_budget) return;
  const emitted = result.content_preview === "[empty source]" && span.content_end === span.content_start
    ? "" : result.content_preview;
  const byteLength = Buffer.byteLength(emitted, "utf8");
  if (result.budget_state.within_budget && emitted !== full.text) {
    throw new AlayaError("CONFLICT", "emitted source preview differs from sealed source span");
  }
  if (byteLength > span.content_end - span.content_start) {
    throw new AlayaError("CONFLICT", "emitted source preview exceeds sealed source span");
  }
  const chunk = hydrateUtf8Chunk(source, { offset: span.content_start, byteLimit: byteLength });
  if (chunk.status !== "chunk" || chunk.end_offset !== span.content_start + byteLength || chunk.text !== emitted) {
    throw new AlayaError("CONFLICT", "emitted source preview differs from sealed source span");
  }
}
