import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, SoulInterpretationPrepareQueryResponseSchema, canonicalJson,
  SourceSemanticWorkerWorkSchema, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { sourceSemanticAccessInputIdentity } from "@do-soul/alaya-core";
import { isContainedPath, samePhysicalLocation } from "../fs/opened-contained-path.js";
import { sourceGoldUnitFromPublishedRoot, sourceTargetJoinsGold } from "../measurement/source-gold-join.js";
import { readLongMemEvalSemanticFreeze, loadFrozenLongMemEvalDataset } from "../longmemeval-semantic/contract.js";
import { LongMemEvalPreparedSchema, verifyLongMemEvalQuestionChain,
  verifyLongMemEvalQuestionPublication } from "../longmemeval-semantic/execute.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../semantic-chain/contract.js";
import { SourceAccessDiagnosticObservationSchema, SourceAccessDiagnosticEvaluationSchema,
  type SourceAccessArtifactRef, type SourceAccessDiagnosticObservation,
  type SourceAccessDiagnosticRow, type SourceAccessDiagnosticEvaluation,
  NOT_EXERCISED } from "./contract.js";

const PageSchema = z.object({ response: SoulInterpretationPrepareQueryResponseSchema,
  wall_ms: z.number().nonnegative() }).strict();
const StartedSchema = z.object({ question_id: z.string(), policy: z.string(),
  page_number: z.number().int().nonnegative(), source_offset: z.number().int().nonnegative(),
  prior_pool_id: z.string().nullable() }).strict();
const ResultSchema = z.object({ question_id: z.string(), policy: z.string(),
  page_number: z.number().int().nonnegative(), work: SourceSemanticWorkerWorkSchema,
  provider_attempts: z.number().int().nonnegative(), response_identity: z.string(),
  wall_ms: z.number().nonnegative() }).strict();
const RunStartSchema = z.object({ contract: z.literal("source-access-diagnostic-start-v1"),
  config: SourceAccessDiagnosticObservationSchema.shape.config,
  slots: z.array(z.object({ question_id: z.string(), policy: z.string() }).strict()) }).strict();
const KS = [5, 20, 30, 50] as const;
type Metric = "hit" | "miss" | "unknown";

/** Gold is loaded only in this separate evaluator, after access artifacts are frozen. */
export async function evaluateSourceAccessDiagnostic(observationPath: string, outputRoot: string) {
  if (!isAbsolute(outputRoot) || lstatExists(outputRoot)) {
    throw new AlayaError("CONFLICT", "diagnostic evaluation requires a new absolute output root");
  }
  const observation = SourceAccessDiagnosticObservationSchema.parse(readChainArtifact(observationPath));
  const sourceRoot = resolve(observation.config.source_run_root);
  const root = resolve(outputRoot), observationRoot = dirname(resolve(observationPath));
  if ([sourceRoot, observationRoot].some((prior) => samePhysicalLocation(root, prior)
    || isContainedPath(prior, root) || isContainedPath(root, prior))) {
    throw new AlayaError("CONFLICT", "diagnostic evaluation output must be isolated from source and observation roots");
  }
  const frozen = readLongMemEvalSemanticFreeze(sourceRoot);
  if (frozen.contract !== "longmemeval-semantic-development-v3"
    || chainIdentity(frozen) !== observation.freeze_identity
    || frozen.implementation_revision !== observation.implementation_revision
    || canonicalJson(frozen.selected.map((row) => row.question_id)) !== canonicalJson(observation.config.expected_question_ids)
    || canonicalJson(frozen.config.budget) !== canonicalJson(observation.config.budget)) {
    throw new AlayaError("CONFLICT", "diagnostic observation and current source freeze differ");
  }
  if (!isContainedPath(sourceRoot, resolve(observation.config.prepared_path))) {
    throw new AlayaError("CONFLICT", "diagnostic prepared artifact escaped its source root");
  }
  const prepared = LongMemEvalPreparedSchema.parse(readChainArtifact(observation.config.prepared_path));
  if (chainIdentity(prepared) !== observation.prepared_identity || prepared.freeze_identity !== chainIdentity(frozen)) {
    throw new AlayaError("CONFLICT", "diagnostic prepared publication changed");
  }
  const expected = frozen.selected.flatMap((row) => observation.config.policies.map((policy) =>
    `${row.question_id}\u0000${policy}`));
  const actual = observation.rows.map((row) => `${row.question_id}\u0000${row.policy}`);
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new AlayaError("CONFLICT", "diagnostic question and policy denominator changed");
  }
  let runEvidenceError: string | null = null;
  try { assertRunEvidence(observationRoot, observation); }
  catch (error) { runEvidenceError = error instanceof Error ? error.message : String(error); }
  const dataset = await loadFrozenLongMemEvalDataset(frozen.config);
  const rows: SourceAccessDiagnosticEvaluation["rows"][number][] = [];
  for (const row of observation.rows) {
    const selected = frozen.selected.find((entry) => entry.question_id === row.question_id)!;
    if (row.index !== selected.index) throw new AlayaError("CONFLICT", "diagnostic original question index changed");
    const question = dataset.questions[selected.index]!;
    if (question.question_id !== selected.question_id || question.question !== selected.question) {
      throw new AlayaError("CONFLICT", "diagnostic original question differs from frozen dataset");
    }
    const preparedRow = prepared.rows.find((entry) => entry.question_id === row.question_id)!;
    if (runEvidenceError !== null) { rows.push(unknownRow(row, runEvidenceError, true)); continue; }
    if (row.status === "unattempted" && (row.attempted_pages !== 0 || row.attempt_evidence.length !== 0)) {
      rows.push(unknownRow(row, "unattempted row declares native attempts", true)); continue;
    }
    if (row.status === "unattempted" || row.status === "failed" || preparedRow.status !== "prepared") {
      rows.push(unknownRow(row, row.reason ?? "native access unavailable")); continue;
    }
    const expectedInputId = sourceSemanticAccessInputIdentity({ original_query: selected.question,
      budget: frozen.config.budget, policy: row.policy });
    rows.push(evaluatePreparedRow(observationPath, sourceRoot, frozen, selected,
      preparedRow.publication_path, preparedRow.publication_identity, preparedRow.chain_root,
      question.answer_session_ids, row, expectedInputId));
  }
  const summary = observation.config.policies.flatMap((policy) => KS.map((k) => {
    const policyRows = rows.filter((row) => row.policy === policy);
    const values = policyRows.map((row) => row[`pool_at_${k}` as const]);
    return { policy, k, denominator: values.length,
      hits: values.filter((value) => value === "hit").length,
      misses: values.filter((value) => value === "miss").length,
      unknown: values.filter((value) => value === "unknown").length,
      unattempted: policyRows.filter((row) => row.status === "unattempted").length,
      unknown_before_attempt: policyRows.filter((row) => row[`pool_at_${k}` as const] === "unknown"
        && row.status !== "unattempted" && row.attempted_pages === 0).length,
      unknown_after_attempt: policyRows.filter((row) => row[`pool_at_${k}` as const] === "unknown"
        && row.attempted_pages > 0).length,
      pool_k_unit: "source_root" as const };
  }));
  const result = SourceAccessDiagnosticEvaluationSchema.parse({
    contract: "source-access-diagnostic-evaluation-v2", observation_identity: chainIdentity(observation),
    freeze_identity: observation.freeze_identity, rows, summary, ...NOT_EXERCISED
  });
  mkdirSync(outputRoot, { recursive: true });
  const path = resolve(outputRoot, "evaluation.json");
  writeChainArtifact(path, result);
  return { path, result };
}

function evaluatePreparedRow(observationPath: string, sourceRoot: string,
  frozen: ReturnType<typeof readLongMemEvalSemanticFreeze>,
  selected: ReturnType<typeof readLongMemEvalSemanticFreeze>["selected"][number],
  publicationPath: string, publicationIdentity: string, chainRoot: string,
  answerSessionIds: readonly string[], row: SourceAccessDiagnosticRow, expectedInputId: string):
  SourceAccessDiagnosticEvaluation["rows"][number] {
  try {
    const directory = resolve(sourceRoot, "questions", String(selected.index).padStart(5, "0"));
    if (publicationPath !== resolve(directory, "publication.json")) {
      throw new AlayaError("CONFLICT", "diagnostic prepared publication path changed");
    }
    const publication = verifyLongMemEvalQuestionPublication(frozen, selected, directory,
      readChainArtifact(publicationPath));
    if (chainIdentity(publication) !== publicationIdentity) {
      throw new AlayaError("CONFLICT", "diagnostic prepared publication identity changed");
    }
    verifyLongMemEvalQuestionChain(frozen, selected, directory, publication, chainRoot);
    if (publication.admitted_count !== selected.source_manifest.length || publication.published_count !== 0) {
      return unknownRow(row, "raw source publication is incomplete");
    }
    const answerSessions = new Set(answerSessionIds);
    const goldRows = publication.sources.filter((source) => answerSessions.has(source.session_id)
      && source.admission === "admitted" && source.record_id !== undefined);
    if (answerSessions.size === 0 || [...answerSessions].some((id) => !goldRows.some((source) => source.session_id === id))) {
      return unknownRow(row, "gold session has no admitted published source");
    }
    const goldUnits = goldRows.map((source) => sourceGoldUnitFromPublishedRoot(sourceRecallTarget({
      workspace_id: publication.workspace_id, root_kind: "source_record", root_id: source.record_id!,
      source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null
    })));
    const { candidates, interpretationOpen } = readOrderedCandidates(observationPath, row,
      selected.source_manifest.length, expectedInputId);
    const byId = new Map(publication.sources.filter((source) => source.admission === "admitted" && source.record_id !== undefined)
      .map((source) => [source.source_id, source]));
    const slots = candidates.map((candidate, index) => {
      const source = byId.get(candidate.source_id);
      if (source === undefined || source.record_id !== candidate.record_id) {
        throw new AlayaError("CONFLICT", "native source pool contains a foreign publication root");
      }
      return { rank: index + 1, session_id: source.session_id, object_kind: "source_evidence",
        target: sourceRecallTarget({ workspace_id: publication.workspace_id, root_kind: "source_record",
          root_id: source.record_id!, source_version: source.source_version,
          content_digest: source.content_digest, evidence_object_id: null }) };
    });
    const first = slots.find((slot) => goldUnits.some((unit) => sourceTargetJoinsGold(slot, unit)));
    const distinctSessions = new Set<string>();
    let firstGoldSessionRank: number | null = null;
    for (const slot of slots) {
      distinctSessions.add(slot.session_id);
      if (firstGoldSessionRank === null && goldUnits.some((unit) => sourceTargetJoinsGold(slot, unit))) {
        firstGoldSessionRank = distinctSessions.size;
      }
    }
    const fullyPaged = row.status === "observed" && row.observed_source_count === slots.length;
    const completeSourceScan = row.unvisited_sources === false && !interpretationOpen
      && candidates.every((candidate) => candidate.complete);
    const at = (k: number): Metric => first !== undefined && first.rank <= k ? "hit"
      : !completeSourceScan ? "unknown"
      : fullyPaged || slots.length >= k ? "miss" : "unknown";
    return { question_id: row.question_id, index: row.index, policy: row.policy,
      status: "measured", reason: row.status === "partial" ? row.reason : null,
      observation_status: row.status, attempted_pages: row.attempted_pages,
      first_gold_source_rank: first?.rank ?? null, first_gold_session_rank: firstGoldSessionRank,
      source_rank_unit: "source_root", session_rank_unit: "distinct_session",
      pool_k_unit: "source_root", rank_censored: !fullyPaged || !completeSourceScan,
      discovery_complete: fullyPaged && completeSourceScan,
      pool_at_5: at(5), pool_at_20: at(20), pool_at_30: at(30), pool_at_50: at(50) };
  } catch (error) { return unknownRow(row, error instanceof Error ? error.message : String(error)); }
}

function readOrderedCandidates(observationPath: string, row: SourceAccessDiagnosticRow,
  maxSources: number, expectedInputId: string) {
  const root = dirname(resolve(observationPath));
  const candidates: NonNullable<ReturnType<typeof PageSchema.parse>["response"]["access"]>["source_candidates"][number][] = [];
  let poolId: string | null = null, sourceOpen: boolean | null = null;
  let interpretationOpen: boolean | null = null, poolStops: string | null = null;
  const seen = new Set<string>(), stops = new Set<string>();
  const attemptPaths: string[] = [], pagePaths: string[] = [];
  let settled = 0, unresolved = 0, nativeWork = 0, nativeBytes = 0, logicalWork = 0;
  let initialWork = 0, continuationWork = 0, readBytes = 0, incompleteBodies = 0;
  let lastUnvisited: boolean | null = null, observed: number | null = null, pageGap = false;
  if (row.attempt_evidence.length !== row.attempted_pages) throw new AlayaError("CONFLICT", "diagnostic attempt manifest count changed");
  for (const [index, evidence] of row.attempt_evidence.entries()) {
    if (evidence.page_number !== index || pageGap) throw new AlayaError("CONFLICT", "diagnostic attempt sequence changed");
    const started = StartedSchema.parse(readBoundArtifact(root, evidence.started));
    attemptPaths.push(evidence.started.path);
    if (started.question_id !== row.question_id || started.policy !== row.policy || started.page_number !== index
      || started.source_offset !== candidates.length || started.prior_pool_id !== poolId) {
      throw new AlayaError("CONFLICT", "diagnostic started attempt does not bind its source prefix");
    }
    const result = evidence.result === null ? null : ResultSchema.parse(readBoundArtifact(root, evidence.result));
    if (result !== null) {
      attemptPaths.push(evidence.result!.path); settled++;
      if (result.question_id !== row.question_id || result.policy !== row.policy || result.page_number !== index
        || result.provider_attempts !== 0) throw new AlayaError("CONFLICT", "diagnostic settled attempt changed");
      nativeWork += result.work.native_work; nativeBytes += result.work.native_bytes;
      if (result.work.logical_work === undefined) unresolved++;
      else {
        logicalWork += result.work.logical_work;
        if (index === 0) initialWork += result.work.logical_work;
        else continuationWork += result.work.logical_work;
      }
    } else unresolved++;
    if (evidence.page === null) { pageGap = true; continue; }
    if (result === null) throw new AlayaError("CONFLICT", "diagnostic page has no settled attempt");
    const page = PageSchema.parse(readBoundArtifact(root, evidence.page));
    pagePaths.push(evidence.page.path);
    const access = page.response.access;
    if (chainIdentity(page.response) !== result.response_identity
      || chainIdentity(page.response.work) !== chainIdentity(result.work)
      || page.response.provider_attempts !== result.provider_attempts || page.wall_ms !== result.wall_ms
      || page.response.work.logical_work === undefined || access === undefined
      || access.trace.kind !== "preparation_page" || access.policy !== row.policy
      || access.input_id !== expectedInputId
      || access.trace.source_offset !== candidates.length || poolId !== null && access.pool_id !== poolId
      || sourceOpen !== null && access.unvisited_sources !== sourceOpen
      || interpretationOpen !== null && access.unvisited_interpretations !== interpretationOpen
      || poolStops !== null && canonicalJson(access.stopping_reasons) !== poolStops
      || access.pool_id !== row.pool_id
      || access.observed_source_count !== row.observed_source_count
      || !access.unvisited_sources && access.observed_source_count !== maxSources
      || access.observed_interpretation_count !== 0 || access.interpretation_candidates.length !== 0
      || access.trace.interpretation_offset !== 0 || access.trace.omitted_interpretation_count !== 0
      || page.response.query_handle === undefined || page.response.query_semantics_id !== undefined
      || page.response.query_semantics_status.status !== "unavailable"
      || page.response.query_semantics_status.reason !== "absent"
      || page.response.candidates.length !== 0 || page.response.outcome?.status !== "preparation_required"
      || page.response.outcome.missing !== "query_semantics") {
      throw new AlayaError("CONFLICT", "diagnostic page and settled native response differ");
    }
    poolId = access.pool_id; sourceOpen = access.unvisited_sources;
    interpretationOpen = access.unvisited_interpretations;
    poolStops = canonicalJson(access.stopping_reasons);
    observed = access.observed_source_count;
    lastUnvisited = access.unvisited_sources;
    for (const stop of access.stopping_reasons) stops.add(stop);
    const beforePage = candidates.length;
    for (const candidate of access.source_candidates) {
      if (seen.has(candidate.source_id)) throw new AlayaError("CONFLICT", "native pool repeated a source");
      seen.add(candidate.source_id); candidates.push(candidate);
      readBytes += candidate.read_bytes;
      if (!candidate.complete) incompleteBodies++;
    }
    if (observed > maxSources || observed < candidates.length || observed > 0 && candidates.length === beforePage
      || index < row.attempt_evidence.length - 1
        && (candidates.length === observed || page.response.continuation_handle === undefined)) {
      throw new AlayaError("CONFLICT", "diagnostic native source count changed");
    }
    const open = access.unvisited_sources || access.unvisited_interpretations;
    if (page.response.coverage.discovery !== (open ? "truncated" : "complete")
      || page.response.truncated !== (candidates.length < observed || open)) {
      throw new AlayaError("CONFLICT", "diagnostic source-only coverage contradicts its native trace");
    }
  }
  if (chainIdentity(pagePaths) !== chainIdentity(row.page_paths)
    || chainIdentity(attemptPaths) !== chainIdentity(row.attempt_paths)
    || settled !== row.settled_pages || unresolved !== row.unresolved_attempts
    || nativeWork !== row.native_work || nativeBytes !== row.native_bytes
    || logicalWork !== row.logical_work || initialWork !== row.initial_logical_work
    || continuationWork !== row.continuation_logical_work || readBytes !== row.source_read_bytes
    || incompleteBodies !== row.incomplete_source_bodies || candidates.length !== row.retained_source_count
    || observed !== row.observed_source_count || lastUnvisited !== row.unvisited_sources
    || chainIdentity([...stops]) !== chainIdentity(row.stopping_reasons)
    || (observed === null ? null : observed - candidates.length) !== row.unretained_observed_sources
    || poolId !== row.pool_id || (row.status === "observed") !== (observed !== null && candidates.length === observed)) {
    throw new AlayaError("CONFLICT", "diagnostic retained evidence contradicts observation summary");
  }
  if (pagePaths.length === 0) throw new AlayaError("CONFLICT", "no retained native access page");
  return { candidates, interpretationOpen: interpretationOpen ?? true };
}

function readBoundArtifact(root: string, ref: SourceAccessArtifactRef): unknown {
  const absolute = resolve(root, ref.path);
  if (!isContainedPath(root, absolute)) throw new AlayaError("CONFLICT", "diagnostic artifact escaped its observation root");
  const value = readChainArtifact(absolute);
  if (value === undefined || chainIdentity(value) !== ref.identity) {
    throw new AlayaError("CONFLICT", "diagnostic artifact identity or file is missing");
  }
  return value;
}

function assertRunEvidence(root: string, observation: SourceAccessDiagnosticObservation): void {
  const start = RunStartSchema.parse(readBoundArtifact(root, observation.start_artifact));
  const slots = observation.config.expected_question_ids.flatMap((question_id) =>
    observation.config.policies.map((policy) => ({ question_id, policy })));
  if (chainIdentity(start.config) !== chainIdentity(observation.config)
    || chainIdentity(start.slots) !== chainIdentity(slots)
    || observation.total_pages !== observation.rows.reduce((sum, row) => sum + row.page_paths.length, 0)
    || observation.attempted_pages !== observation.rows.reduce((sum, row) => sum + row.attempted_pages, 0)
    || observation.settled_pages !== observation.rows.reduce((sum, row) => sum + row.settled_pages, 0)
    || observation.unresolved_attempts !== observation.rows.reduce((sum, row) => sum + row.unresolved_attempts, 0)
    || observation.total_logical_work !== observation.rows.reduce((sum, row) => sum + row.logical_work, 0)) {
    throw new AlayaError("CONFLICT", "diagnostic run start or aggregate evidence changed");
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function unknownRow(row: SourceAccessDiagnosticRow, reason: string, forceUnknown = false) {
  return { question_id: row.question_id, index: row.index, policy: row.policy,
    status: row.status === "unattempted" && !forceUnknown ? "unattempted" as const : "unknown" as const, reason,
    observation_status: row.status, attempted_pages: row.attempted_pages,
    first_gold_source_rank: null, first_gold_session_rank: null,
    source_rank_unit: "source_root" as const, session_rank_unit: "distinct_session" as const,
    pool_k_unit: "source_root" as const, rank_censored: true,
    discovery_complete: null, pool_at_5: "unknown" as const, pool_at_20: "unknown" as const,
    pool_at_30: "unknown" as const, pool_at_50: "unknown" as const };
}
