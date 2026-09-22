import { z } from "zod";
import { dirname, join } from "node:path";
import { canonicalJson, hashSourceRecordId } from "@do-soul/alaya-protocol";
import { fieldContractSha256, sourceSemanticLibraryQueryIdentity } from "@do-soul/alaya-core";
import { chainIdentity } from "../semantic-chain/contract.js";
import { LongMemEvalSemanticFreezeSchema, assertLongMemEvalSemanticRows,
  type LongMemEvalSemanticFreeze } from "../longmemeval-semantic/contract.js";
import { LongMemEvalPreparedSchema, LongMemEvalReplaySchema, LongMemEvalPublicationSchema,
  LongMemEvalSourceOnlyResponseSchema } from "../longmemeval-semantic/execute.js";
import { readmitSourceSemanticLibraryMeasurement, type SourceSemanticLibraryEvaluatorUsage } from "./source-semantic-library-measurement.js";
import { SOURCE_BEARING_UNION_FIRST_EXPOSURE_CONTRACT, SourceGoldUnitSchema } from "./source-gold-join.js";
import { FirstExposurePageSchema } from "./first-exposure-session.js";

// This offline report admits the frozen population, not a runnable producer workset.
const FrozenPopulationSchema = LongMemEvalSemanticFreezeSchema.pick({ config: true, implementation_revision: true, inventory: true, selected: true }).passthrough();
type FrozenPopulation = z.infer<typeof FrozenPopulationSchema>;

export interface FrozenUnionRowReport {
  readonly question_id: string;
  readonly stored_outcome: string | null;
  readonly stored_reason: string | null;
  readonly difference: "same" | "different" | "not_computed";
  readonly cause: string;
  readonly stored_mixed_any_at_5: "hit" | "miss" | "unavailable" | null;
  readonly union_any_at_5: "hit" | "miss" | "unavailable" | null;
  readonly in_development_denominator: boolean;
  readonly evaluator_usage?: SourceSemanticLibraryEvaluatorUsage;
}

export interface FrozenUnionEvidence {
  readonly summary: unknown;
  readonly freeze: unknown;
  readonly prepared: unknown;
  readonly replay: unknown;
}

/** Compare retained evidence only. The frozen census, never surviving files, owns the denominator. */
export function reportFrozenSourceBearingUnion(evidence: FrozenUnionEvidence, readText: (path: string) => string) {
  const summary = envelope(evidence.summary);
  const frozen = FrozenPopulationSchema.parse(envelope(evidence.freeze));
  const prepared = LongMemEvalPreparedSchema.parse(envelope(evidence.prepared));
  const replay = LongMemEvalReplaySchema.parse(envelope(evidence.replay));
  const freezeId = chainIdentity(frozen);
  if (summary.contract !== "longmemeval-semantic-measurement-v1" || summary.provider_calls !== 0
    || summary.freeze_identity !== freezeId || summary.replay_identity !== chainIdentity(replay)
    || summary.dataset_sha256 !== frozen.config.dataset_sha256 || prepared.freeze_identity !== freezeId
    || replay.freeze_identity !== freezeId || replay.prepared_identity !== chainIdentity(prepared)) {
    throw new Error("frozen comparison identity chain is inconsistent");
  }
  assertLongMemEvalSemanticRows(frozen, prepared.rows);
  assertLongMemEvalSemanticRows(frozen, replay.rows);
  const rows = population(frozen, summary);
  const reported = rows.map((row) => {
    const selected = frozen.selected.find((item) => item.question_id === row.question_id);
    if (selected === undefined || selected.cohort === "abstention") return reportRow(row, false,
      "outside the answerable development denominator", null);
    const replayed = replay.rows.find((item) => item.question_id === selected.question_id)!;
    const preparedRow = prepared.rows.find((item) => item.question_id === selected.question_id)!;
    if (replayed.status !== "replayed" || preparedRow.status !== "prepared") {
      return reportRow(row, true, `native replay unavailable; preparation=${preparedRow.status}${"reason" in preparedRow ? `:${preparedRow.reason}` : ""}; replay=${replayed.status}${"reason" in replayed ? `:${replayed.reason}` : ""}; denominator retained`, "unavailable");
    }
    if (replayed.chain_root !== preparedRow.chain_root || replayed.publication_path !== preparedRow.publication_path
      || replayed.publication_identity !== preparedRow.publication_identity) {
      return reportRow(row, true, "prepared and replayed publication differ", "unavailable");
    }
    try { return measuredRow(row, frozen, selected, replayed, readText); }
    catch (error) {
      const reason = error instanceof SyntaxError ? "corrupt_json" : error instanceof Error && "code" in error
        && error.code === "ENOENT" ? "missing_artifact" : error instanceof Error ? error.message : "invalid_evidence";
      return reportRow(row, true, `${reason}; denominator retained`, "unavailable");
    }
  });
  const development = reported.filter((row) => row.in_development_denominator);
  const hits = development.filter((row) => row.union_any_at_5 === "hit").length;
  const unknown = development.filter((row) => row.union_any_at_5 !== "hit" && row.union_any_at_5 !== "miss").length;
  return {
    contract: SOURCE_BEARING_UNION_FIRST_EXPOSURE_CONTRACT,
    result_unit: "session_bearing_source_round", replaces_mixed_v1: false, replaces_proof_conditioned_v1: false,
    complete_answer_proof: "partial_or_unsupported", proof_conditioned_diagnostic: "proof-conditioned-first-exposure-any-at-k-v1",
    historical_metric: "session-bearing-source-round-mixed-any-at-5", historical_comparator: "session-bearing-source-round-mixed-any-at-5",
    forbidden_memory_id_denominator: "gold-memory-ids-any-at-k",
    request_identity: "query digest and requested operation stay on the authoritative request",
    native_comparison: "lt|le|eq|ge|gt|minimum|maximum",
    evidence_demand: "union hit means a source round is present; it is not a complete answer",
    client_computation: "general count and date subtraction", delivered_support: "not_scored", required_evidence_coverage: "not_scored",
    abstention: "uncalibrated_outside_470", missing_measurement_changes_n: false,
    development_n: development.length, formal_n: 470, formal_threshold: 424,
    bounds: { hits, unknown, lower: development.length === 0 ? 0 : hits / development.length,
      upper: development.length === 0 ? 0 : (hits + unknown) / development.length },
    historical_mixed_primary: summary.primary, stored_inventory: summary.inventory, stored_formal_target: summary.formal_target,
    rows: reported
  } as const;
}

function population(frozen: FrozenPopulation, summary: Record<string, unknown>): Record<string, unknown>[] {
  const inventory = frozen.inventory;
  const selected = new Set(frozen.selected.map((row) => row.question_id));
  if (inventory.length !== frozen.config.dataset_question_count || inventory.length !== 500
    || inventory.filter((row) => row.cohort === "answerable").length !== 470
    || new Set(inventory.map((row) => row.question_id)).size !== inventory.length
    || inventory.some((row, index) => row.index !== index)
    || selected.size !== frozen.selected.length
    || canonicalJson([...selected].sort()) !== canonicalJson([...frozen.config.question_ids].sort())
    || frozen.selected.some((row) => !inventory.some((entry) => entry.question_id === row.question_id
      && entry.index === row.index && entry.cohort === row.cohort))) throw new Error("frozen census or selection is inconsistent");
  const rows = records(summary.rows);
  if (new Set(rows.map((row) => row.question_id)).size !== rows.length || rows.some((row) =>
    !inventory.some((entry) => row.question_id === entry.question_id && row.index === entry.index
      && row.cohort === entry.cohort && row.selected === selected.has(entry.question_id)))) {
    throw new Error("summary row identity differs from frozen census");
  }
  const primary = record(summary.primary), summaryInventory = record(summary.inventory);
  if (primary.eligible !== frozen.selected.filter((row) => row.cohort === "answerable").length
    || summaryInventory.questions !== 500 || summaryInventory.answerable !== 470 || summaryInventory.abstention !== 30) {
    throw new Error("summary denominator differs from frozen census");
  }
  return inventory.map((entry) => rows.find((row) => row.question_id === entry.question_id)
    ?? { ...entry, selected: selected.has(entry.question_id), outcome: "unknown", reason: "missing_summary_row", measurement_path: null });
}

function measuredRow(row: Record<string, unknown>, frozen: FrozenPopulation, selected: LongMemEvalSemanticFreeze["selected"][number],
  replayed: Extract<ReturnType<typeof LongMemEvalReplaySchema.parse>["rows"][number], { status: "replayed" }>,
  readText: (path: string) => string): FrozenUnionRowReport {
  if (typeof row.measurement_path !== "string") return reportRow(row, true,
    `${typeof row.reason === "string" ? row.reason : "missing_measurement_path"}; denominator retained`, "unavailable");
  const measurement = readEnvelope(row.measurement_path, readText);
  if (row.measurement_path !== join(replayed.chain_root, `measurement-${chainIdentity(measurement)}.json`)) {
    throw new Error("measurement path does not bind this question chain");
  }
  const replay = readEnvelope(replayed.replay_path, readText);
  const plan = readEnvelope(join(replayed.chain_root, "prepare.json"), readText);
  const publication = LongMemEvalPublicationSchema.parse(readEnvelope(replayed.publication_path, readText));
  const replayRow = one(replay.rows, selected.query_key), chainRow = one(measurement.rows, selected.query_key);
  const planned = one(plan.queries, selected.query_key), gold = one(measurement.gold, selected.query_key);
  const config = record(plan.config);
  const queryWorkset = record(frozen.query_workset);
  const queryItems = records(queryWorkset.items);
  const selectedIndex = frozen.selected.findIndex((item) => item.question_id === selected.question_id);
  if (measurement.contract !== "source-semantic-chain-measurement-v1" || replay.contract !== "source-semantic-chain-replay-v1"
    || replay.plan_identity !== chainIdentity(plan) || measurement.replay_identity !== replay.identity || replay.provider_calls !== 0
    || chainIdentity(publication) !== replayed.publication_identity || config.snapshot_sha256 !== publication.db_sha256
    || config.workspace_id !== publication.workspace_id || config.interpretation_clock !== selected.interpretation_clock
    || config.snapshot_path !== publication.snapshot_path || config.run_id !== publication.run_id
    || config.implementation_revision !== frozen.implementation_revision
    || canonicalJson(config.budget) !== canonicalJson(frozen.config.budget)
    || config.output_byte_limit !== frozen.config.output_byte_limit || config.max_output_tokens !== frozen.config.max_output_tokens
    || config.query_cache_root !== frozen.config.query_cache_root
    || canonicalJson(config.query_workset) !== canonicalJson({ ...queryWorkset, items: [queryItems[selectedIndex]] })
    || publication.recorded_at !== frozen.config.recorded_at || publication.workspace_id !== `longmemeval-semantic-${selected.index}`
    || publication.run_id !== `longmemeval-semantic-${selected.index}`
    || publication.snapshot_path !== join(dirname(replayed.publication_path), "library.sqlite")
    || planned.original_query !== selected.question || publication.census_count !== selected.source_manifest.length
    || publication.sources.some((source) => source.question_id !== selected.question_id)
    || canonicalJson(publication.sources.map(sourceIdentity)) !== canonicalJson(selected.source_manifest.map(sourceIdentity))) {
    throw new Error("question publication, plan, replay or measurement binding differs");
  }
  const response = record(replayRow.response);
  LongMemEvalSourceOnlyResponseSchema.parse(response);
  const index = record(response.index);
  const sourceGoldUnits = SourceGoldUnitSchema.array().parse(gold.source_units);
  if (typeof index.result_version !== "string" || index.query_id !== sourceSemanticLibraryQueryIdentity(selected.question, index.result_version)
    || index.as_of !== selected.interpretation_clock
    || sourceGoldUnits.some((unit) => unit.workspace_id !== publication.workspace_id || !publication.sources.some((source) =>
      source.admission === "admitted" && source.record_id === unit.root_id && unit.root_kind === "source_record"
      && source.record_id === hashSourceRecordId(source, fieldContractSha256)
      && source.source_version === unit.source_version && source.content_digest === unit.content_digest))) {
    throw new Error("stored measurement differs from native first exposure or gold publication");
  }
  const evaluated = readmitSourceSemanticLibraryMeasurement(chainRow.measurement, { recallResult: archivedSourceResponse(response),
    firstExposurePage: FirstExposurePageSchema.parse(replayRow.first_exposure), requestBudget: frozen.config.budget,
    goldSourceUnits: sourceGoldUnits });
  const measured = evaluated.measurement, union = evaluated.sourceBearingUnion;
  if (measured?.status !== "validated" || union === null) return { ...reportRow(row, true,
    `native response admission failed: ${measured?.status === "invalid" ? measured.reason : "invalid_response"}`, "unavailable"), evaluator_usage: evaluated.evaluator_usage };
  const mixed = measured.metrics.mixed_kind_first_exposure.any_at_5.status;
  if (union.any_at_5.status === "miss" && (row.outcome !== "miss"
    || publication.admitted_count !== selected.source_manifest.length)) {
    return { ...reportRow(row, true, typeof row.reason === "string" ? row.reason : "source_or_gold_mapping_incomplete", "unavailable", mixed),
      evaluator_usage: evaluated.evaluator_usage };
  }
  return { ...reportRow(row, true, `validated native slots; proof ranks ${evaluated.validatedProofRanks.join(",") || "none"}`,
    union.any_at_5.status, mixed), evaluator_usage: evaluated.evaluator_usage };
}

/** Archive-only field migration; the current native admission still owns every validity rule. */
function archivedSourceResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (response.protocol_version !== 1) return response;
  if (response.operation !== "recall" || record(response.index).result_version !== "source-semantic-library-v1"
    || records(response.proofs ?? []).length !== 0
    || records(response.slot_qualifiers).some((slot) => slot.evidence_kind !== "source_evidence")) {
    throw new Error("unsupported historical response");
  }
  const rename = (value: unknown, fields: Readonly<Record<string, string>>) => {
    const result = { ...record(value) };
    for (const [oldName, name] of Object.entries(fields)) {
      if (!(oldName in result) || name in result) throw new Error("ambiguous historical response fields");
      result[name] = result[oldName];
      delete result[oldName];
    }
    return result;
  };
  return { ...response, protocol_version: 2,
    coverage: rename(response.coverage, { h: "source_interpretation", q: "query_semantics", a: "semantic_correspondence", computation: "conditional_computation" }),
    discovery: rename(response.discovery, { visited_h_pages: "visited_source_interpretation_pages",
      visited_h_descriptors: "visited_source_interpretation_descriptors", examined_h_ids: "examined_source_interpretation_ids",
      unexamined_h_count: "unexamined_source_interpretation_count" }) };
}

function sourceIdentity(row: { source_id: string; source_version: string; content_digest: string; session_id: string }) {
  const { source_id, source_version, content_digest, session_id } = row;
  return { source_id, source_version, content_digest, session_id };
}
function envelope(value: unknown): Record<string, unknown> {
  const raw = record(value), payload = record(raw.payload);
  if (typeof raw.identity !== "string" || raw.identity !== chainIdentity(payload)) throw new Error("artifact envelope identity mismatch");
  return payload;
}
function readEnvelope(path: string, readText: (path: string) => string) { return envelope(JSON.parse(readText(path))); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("artifact object unavailable");
  return value as Record<string, unknown>;
}
function records(value: unknown) {
  if (!Array.isArray(value)) throw new Error("artifact rows unavailable");
  return value.map(record);
}
function one(value: unknown, queryKey: string) {
  const rows = records(value);
  if (rows.length !== 1 || rows[0]!.query_key !== queryKey) throw new Error("artifact query identity mismatch");
  return rows[0]!;
}
function reportRow(row: Record<string, unknown>, selected: boolean, cause: string,
  union: FrozenUnionRowReport["union_any_at_5"], mixed: FrozenUnionRowReport["stored_mixed_any_at_5"] = null): FrozenUnionRowReport {
  return { question_id: String(row.question_id), stored_outcome: typeof row.outcome === "string" ? row.outcome : null,
    stored_reason: typeof row.reason === "string" ? row.reason : null,
    in_development_denominator: selected, cause, union_any_at_5: union, stored_mixed_any_at_5: mixed,
    difference: union === null || union === "unavailable" ? "not_computed" : union === mixed ? "same" : "different" };
}
