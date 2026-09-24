import { AlayaError } from "@do-soul/alaya-protocol";
import { join, resolve } from "node:path";
import { admitEvaluatorOutputRoot } from "../measurement/evaluator-output.js";
import { measureSemanticChain, semanticChainReplayInputPaths } from "../semantic-chain/replay.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../semantic-chain/contract.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import type { LongMemEvalQuestion } from "../../datasets/longmemeval/ingestion/dataset.js";
import { longMemEvalDatasetInputPaths } from "../../datasets/longmemeval/ingestion/fetch.js";
import { classifyLongMemEvalDatasetCohort } from "../selection/dataset-cohort.js";
import { LongMemEvalExperimentReplaySchema, LongMemEvalSourceOnlyReplaySchema, verifyLongMemEvalQuestionPublication, verifyLongMemEvalQuestionChain,
  type QuestionPublicationSchema } from "./execute.js";
import type { z } from "zod";
import { assertLongMemEvalSemanticRows, loadFrozenLongMemEvalDataset, readLongMemEvalSemanticFreeze } from "./contract.js";

type LongMemEvalOutcome = Readonly<{
  index: number; question_id: string; cohort: "answerable" | "abstention"; selected: boolean;
  outcome: "hit" | "miss" | "unknown" | "uncalibrated" | "not_selected_development";
  measurement_path: string | null; reason: string | null; mechanism: "not_exercised" | "proof_exercised";
  attribution: { layer: string; native: unknown };
}>;

/** Original answer-session membership joins only admitted source records in the verified publication. */
export function joinLongMemEvalGold(question: Pick<LongMemEvalQuestion, "answer_session_ids">,
  publication: z.infer<typeof QuestionPublicationSchema>, expectedSourceCount: number) {
  const answerSessions = new Set(question.answer_session_ids);
  const goldSources = publication.sources.filter(source => answerSessions.has(source.session_id));
  const sourceUnits = goldSources.filter(source => source.admission === "admitted" && source.record_id !== undefined)
    .map(source => SourceGoldUnitSchema.parse({ workspace_id: publication.workspace_id, root_kind: "source_record",
      root_id: source.record_id, source_version: source.source_version, content_digest: source.content_digest }));
  const complete = answerSessions.size > 0 && publication.admitted_count === expectedSourceCount &&
    [...answerSessions].every(id => goldSources.some(source => source.session_id === id &&
      source.admission === "admitted" && source.record_id !== undefined));
  return { sourceUnits, complete };
}

/** A verified positive survives an incomplete gold join; only absence needs full coverage. */
export function longMemEvalMetricOutcome(metric: { status: string } | undefined, complete: boolean):
  "hit" | "miss" | "unknown" {
  if (metric?.status === "hit") return "hit";
  if (metric?.status === "miss" && complete) return "miss";
  return "unknown";
}

/** Fixed selected-population denominator; abstention remains a separate inventory row. */
export function summarizeLongMemEvalOutcomes(rows: readonly {
  cohort: "answerable" | "abstention";
  outcome: "hit" | "miss" | "unknown" | "uncalibrated" | "not_selected_development";
}[]) {
  const eligible = rows.filter(row => row.cohort === "answerable");
  if (eligible.some(row => row.outcome === "not_selected_development" || row.outcome === "uncalibrated")) {
    throw new AlayaError("CONFLICT", "selected answerable population lost an outcome");
  }
  const hits = eligible.filter(row => row.outcome === "hit").length;
  const misses = eligible.filter(row => row.outcome === "miss").length;
  const unknown = eligible.length - hits - misses;
  return { eligible: eligible.length, hits, misses, unknown,
    lower_bound: eligible.length === 0 ? null : hits / eligible.length,
    upper_bound: eligible.length === 0 ? null : (hits + unknown) / eligible.length };
}

/** Trusted import may parse labels; answer-session gold joins only replayed, publication-admitted rows. */
export async function measureLongMemEvalSemanticRun(root: string, replayPath: string, evaluatorRoot: string) {
  const frozen = readLongMemEvalSemanticFreeze(root);
  const config = frozen.config;
  const replay = LongMemEvalExperimentReplaySchema.parse(readChainArtifact(replayPath));
  if ((replay.contract === "longmemeval-native-semantic-replay-v1") !== (frozen.contract === "longmemeval-native-semantic-v3")) {
    throw new AlayaError("CONFLICT", "replayed experiment arm differs from freeze");
  }
  if (replay.freeze_identity !== chainIdentity(frozen)) throw new AlayaError("CONFLICT", "development replay binds another freeze");
  assertLongMemEvalSemanticRows(frozen, replay.rows);
  const questionPaths = frozen.selected.flatMap((selected) => {
    const directory = resolve(root, "questions", String(selected.index).padStart(5, "0"));
    return [directory, join(directory, "library.sqlite"), join(directory, "publication.json")];
  });
  const replayPaths = replay.rows.flatMap((row) => row.status === "replayed"
    ? [row.chain_root, row.publication_path,
      ...semanticChainReplayInputPaths(row.chain_root, row.replay_path)] : []);
  const datasetPaths = longMemEvalDatasetInputPaths("longmemeval_s", {
    dataDir: config.data_dir, pinnedMetaRoot: config.pinned_meta_root });
  const outputRoot = admitEvaluatorOutputRoot(evaluatorRoot, [root, replayPath, ...questionPaths, ...replayPaths,
    config.data_dir, config.pinned_meta_root, datasetPaths.sourcePath, datasetPaths.checksumSource,
    config.query_cache_root,
    ...("arm" in config ? [config.correspondence_cache_root, ...config.source_cache_roots] : [])]);
  const dataset = await loadFrozenLongMemEvalDataset(frozen.config);
  const selectedRows: LongMemEvalOutcome[] = [];
  for (const selected of frozen.selected) {
    const question = dataset.questions[selected.index]!;
    if (question.question_id !== selected.question_id || classifyLongMemEvalDatasetCohort(question) !== selected.cohort) {
      throw new AlayaError("CONFLICT", "frozen question or cohort changed");
    }
    const replayed = replay.rows.find((row) => row.question_id === selected.question_id)!;
    let outcome: "hit" | "miss" | "unknown" = "unknown";
    let measurementPath: string | null = null;
    let mechanism: LongMemEvalOutcome["mechanism"] = "not_exercised";
    let reason: string | null = replayed.status === "unavailable" ? replayed.reason : null;
    let attribution: LongMemEvalOutcome["attribution"] = { layer: "preparation_unavailable", native: null };
    if (replayed.status === "replayed") {
      try {
        const directory = resolve(root, "questions", String(selected.index).padStart(5, "0"));
        if (replayed.publication_path !== join(directory, "publication.json")) throw new AlayaError("CONFLICT", "question publication path changed");
        const publication = verifyLongMemEvalQuestionPublication(frozen, selected, directory, readChainArtifact(replayed.publication_path));
        if (chainIdentity(publication) !== replayed.publication_identity) throw new AlayaError("CONFLICT", "replayed question publication changed");
        verifyLongMemEvalQuestionChain(frozen, selected, directory, publication, replayed.chain_root);
        const gold = joinLongMemEvalGold(question, publication, selected.source_manifest.length);
        if (frozen.contract === "longmemeval-semantic-development-v3") LongMemEvalSourceOnlyReplaySchema.parse(readChainArtifact(replayed.replay_path));
        const measured = measureSemanticChain(replayed.chain_root, replayed.replay_path,
          [{ query_key: selected.query_key, source_units: gold.sourceUnits }], outputRoot);
        measurementPath = measured.path;
        const measuredRow = measured.result.rows[0];
        if (frozen.contract === "longmemeval-native-semantic-v3" && measuredRow?.status === "replayed"
          && chainIdentity(measuredRow.diagnostics?.order ?? null) !== chainIdentity(frozen.native_route.order)) {
          throw new AlayaError("CONFLICT", "native response order differs from experiment freeze");
        }
        attribution = { layer: measuredRow?.diagnostics?.query_semantics_status?.status === "unavailable" ? "query_unavailable"
          : measuredRow?.status === "blocked" ? "query_unavailable"
          : measuredRow?.status === "native_unavailable" ? "native_unavailable"
            : frozen.contract === "longmemeval-native-semantic-v3" ? "native_semantic_recall" : "source_only_canonical_order",
          native: frozen.contract === "longmemeval-semantic-development-v3" ? measuredRow?.diagnostics ?? null
            : { diagnostics: measuredRow?.diagnostics ?? null, mechanism: measuredRow?.mechanism ?? null,
            evaluator_usage: measuredRow?.evaluator_usage ?? null, publication: {
              published_count: publication.published_count, sources: publication.sources } } };
        mechanism = measuredRow?.mechanism.status === "proof_exercised" ? "proof_exercised" : "not_exercised";
        // Source-only replay rejects proof slots above, so the shared union admission
        // preserves its source metric while retaining the same native residuals.
        const metric = measuredRow?.source_bearing_union?.any_at_5;
        const complete = gold.complete;
        outcome = longMemEvalMetricOutcome(metric, complete);
        if (outcome === "unknown") reason = complete ? measuredRow?.reason ?? "native_measurement_unavailable" : "source_or_gold_mapping_incomplete";
        if (!complete) attribution.layer = "source_or_gold_mapping_incomplete";
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        attribution = { layer: "measurement_unavailable", native: null };
      }
    }
    selectedRows.push({ index: selected.index, question_id: selected.question_id, cohort: selected.cohort, selected: true,
      outcome: selected.cohort === "abstention" ? "uncalibrated" as const : outcome,
      measurement_path: measurementPath, reason, attribution, mechanism });
  }
  const rows = frozen.inventory.map((entry) => ({ ...(selectedRows.find((row) => row.question_id === entry.question_id)
    ?? { ...entry, selected: false, outcome: "not_selected_development" as const,
      measurement_path: null, reason: null, attribution: { layer: "not_selected", native: null }, mechanism: "not_exercised" as const }),
    prior_development_exposure: frozen.config.previously_exposed_question_ids?.includes(entry.question_id) ?? false,
    abstention_calibration: entry.cohort === "abstention" ? "uncalibrated" : "not_applicable" }));
  const primary = summarizeLongMemEvalOutcomes(selectedRows);
  const { hits, unknown } = primary;
  const totalEligible = frozen.inventory.filter((row) => row.cohort === "answerable").length;
  const formal = frozen.config.stage === "formal";
  if (formal && selectedRows.length !== frozen.inventory.length) throw new AlayaError("INTERNAL", "formal result lost dataset rows");
  const requiredHits = Math.floor(0.9 * totalEligible) + 1;
  const decision = !formal ? "development_only" : hits >= requiredHits ? "achieved"
    : hits + unknown < requiredHits ? "not_achieved" : "unresolved";
  const result = { contract: frozen.contract === "longmemeval-native-semantic-v3"
    ? "longmemeval-native-semantic-measurement-v3" : "longmemeval-semantic-measurement-v2", freeze_identity: chainIdentity(frozen),
    replay_identity: chainIdentity(replay), dataset_sha256: frozen.config.dataset_sha256,
    exposure: frozen.exposure, metric: frozen.metric, order_policy: frozen.order_policy,
    mechanism: frozen.mechanism, provider_calls: 0,
    inventory: { questions: rows.length, answerable: totalEligible, abstention: rows.length - totalEligible },
    primary: { ...primary,
      strict_over_90_required_hits: primary.eligible === 0 ? null : Math.floor(0.9 * primary.eligible) + 1, target_decision: decision },
    formal_target: { eligible: totalEligible, strict_over_90_required_hits: totalEligible === 0 ? null : requiredHits,
      status: formal ? decision : "not_run", additional_confirmed_hits_needed: formal ? Math.max(0, requiredHits - hits) : null }, rows };
  const path = join(outputRoot, `measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result); return { path, result };
}
