import { join, resolve } from "node:path";
import { measureSemanticChain } from "../semantic-chain/replay.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../semantic-chain/contract.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import { classifyLongMemEvalDatasetCohort } from "../selection/dataset-cohort.js";
import { LongMemEvalExperimentReplaySchema, LongMemEvalSourceOnlyReplaySchema, verifyLongMemEvalQuestionPublication, verifyLongMemEvalQuestionChain } from "./execute.js";
import { assertLongMemEvalSemanticRows, loadFrozenLongMemEvalDataset, readLongMemEvalSemanticFreeze } from "./contract.js";

type LongMemEvalOutcome = Readonly<{
  index: number; question_id: string; cohort: "answerable" | "abstention"; selected: boolean;
  outcome: "hit" | "miss" | "unknown" | "uncalibrated" | "not_selected_development";
  measurement_path: string | null; reason: string | null; mechanism: "not_exercised" | "proof_exercised";
  attribution: { layer: string; native: unknown };
}>;

/** Gold is read only after native replay is immutable, and never enters publication or retrieval. */
export async function measureLongMemEvalSemanticRun(root: string, replayPath: string) {
  const frozen = readLongMemEvalSemanticFreeze(root);
  const replay = LongMemEvalExperimentReplaySchema.parse(readChainArtifact(replayPath));
  if ((replay.contract === "longmemeval-native-semantic-replay-v1") !== (frozen.contract === "longmemeval-native-semantic-v3")) {
    throw new Error("replayed experiment arm differs from freeze");
  }
  if (replay.freeze_identity !== chainIdentity(frozen)) throw new Error("development replay binds another freeze");
  assertLongMemEvalSemanticRows(frozen, replay.rows);
  const dataset = await loadFrozenLongMemEvalDataset(frozen.config);
  const selectedRows: LongMemEvalOutcome[] = [];
  for (const selected of frozen.selected) {
    const question = dataset.questions[selected.index]!;
    if (question.question_id !== selected.question_id || classifyLongMemEvalDatasetCohort(question) !== selected.cohort) {
      throw new Error("frozen question or cohort changed");
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
        if (replayed.publication_path !== join(directory, "publication.json")) throw new Error("question publication path changed");
        const publication = verifyLongMemEvalQuestionPublication(frozen, selected, directory, readChainArtifact(replayed.publication_path));
        if (chainIdentity(publication) !== replayed.publication_identity) throw new Error("replayed question publication changed");
        verifyLongMemEvalQuestionChain(frozen, selected, directory, publication, replayed.chain_root);
        const answerSessions = new Set(question.answer_session_ids);
        const goldSources = publication.sources.filter((source) => answerSessions.has(source.session_id));
        const gold = goldSources.filter((source) => source.admission === "admitted" && source.record_id !== undefined)
          .map((source) => SourceGoldUnitSchema.parse({ workspace_id: publication.workspace_id, root_kind: "source_record",
            root_id: source.record_id, source_version: source.source_version, content_digest: source.content_digest }));
        if (frozen.contract === "longmemeval-semantic-development-v3") LongMemEvalSourceOnlyReplaySchema.parse(readChainArtifact(replayed.replay_path));
        const measured = measureSemanticChain(replayed.chain_root, replayed.replay_path,
          [{ query_key: selected.query_key, source_units: gold }]);
        measurementPath = measured.path;
        const measuredRow = measured.result.rows[0];
        if (frozen.contract === "longmemeval-native-semantic-v3" && measuredRow?.status === "replayed"
          && chainIdentity(measuredRow.diagnostics?.order ?? null) !== chainIdentity(frozen.native_route.order)) {
          throw new Error("native response order differs from experiment freeze");
        }
        attribution = { layer: measuredRow?.status === "blocked" ? "query_unavailable"
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
        const complete = publication.admitted_count === selected.source_manifest.length
          && [...answerSessions].every((id) => goldSources.some((source) => source.session_id === id && source.record_id !== undefined));
        if (metric?.status === "hit") outcome = "hit";
        else if (metric?.status === "miss" && complete) outcome = "miss";
        else reason = complete ? measuredRow?.reason ?? "native_measurement_unavailable" : "source_or_gold_mapping_incomplete";
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
  const eligible = selectedRows.filter((row) => row.cohort === "answerable");
  const hits = eligible.filter((row) => row.outcome === "hit").length;
  const misses = eligible.filter((row) => row.outcome === "miss").length;
  const unknown = eligible.length - hits - misses;
  const totalEligible = frozen.inventory.filter((row) => row.cohort === "answerable").length;
  const formal = frozen.config.stage === "formal";
  if (formal && selectedRows.length !== frozen.inventory.length) throw new Error("formal result lost dataset rows");
  const requiredHits = Math.floor(0.9 * totalEligible) + 1;
  const decision = !formal ? "development_only" : hits >= requiredHits ? "achieved"
    : hits + unknown < requiredHits ? "not_achieved" : "unresolved";
  const result = { contract: frozen.contract === "longmemeval-native-semantic-v3"
    ? "longmemeval-native-semantic-measurement-v3" : "longmemeval-semantic-measurement-v2", freeze_identity: chainIdentity(frozen),
    replay_identity: chainIdentity(replay), dataset_sha256: frozen.config.dataset_sha256,
    exposure: frozen.exposure, metric: frozen.metric, order_policy: frozen.order_policy,
    mechanism: frozen.mechanism, provider_calls: 0,
    inventory: { questions: rows.length, answerable: totalEligible, abstention: rows.length - totalEligible },
    primary: { eligible: eligible.length, hits, misses, unknown,
      lower_bound: eligible.length === 0 ? null : hits / eligible.length,
      upper_bound: eligible.length === 0 ? null : (hits + unknown) / eligible.length,
      strict_over_90_required_hits: eligible.length === 0 ? null : Math.floor(0.9 * eligible.length) + 1, target_decision: decision },
    formal_target: { eligible: totalEligible, strict_over_90_required_hits: totalEligible === 0 ? null : requiredHits,
      status: formal ? decision : "not_run", additional_confirmed_hits_needed: formal ? Math.max(0, requiredHits - hits) : null }, rows };
  const path = join(root, `measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result); return { path, result };
}
