import { join, resolve } from "node:path";
import { measureSemanticChain } from "../semantic-chain/replay.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../semantic-chain/contract.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import { classifyLongMemEvalDatasetCohort } from "../selection/dataset-cohort.js";
import { DevelopmentReplaySchema, verifyDevelopmentQuestionPublication } from "./execute.js";
import { assertDevelopmentRows, loadFrozenLongMemEvalDataset, readLongMemEvalSemanticFreeze } from "./contract.js";

type DevelopmentOutcome = Readonly<{
  index: number; question_id: string; cohort: "answerable" | "abstention"; selected: boolean;
  outcome: "hit" | "miss" | "unknown" | "uncalibrated" | "not_selected_development";
  measurement_path: string | null; reason: string | null; mechanism: "not_exercised";
}>;

/** Gold is read only after native replay is immutable, and never enters publication or retrieval. */
export async function measureLongMemEvalSemanticDevelopment(root: string, replayPath: string) {
  const frozen = readLongMemEvalSemanticFreeze(root);
  const replay = DevelopmentReplaySchema.parse(readChainArtifact(replayPath));
  if (replay.freeze_identity !== chainIdentity(frozen)) throw new Error("development replay binds another freeze");
  assertDevelopmentRows(frozen, replay.rows);
  const dataset = await loadFrozenLongMemEvalDataset(frozen.config);
  const selectedRows: DevelopmentOutcome[] = [];
  for (const selected of frozen.selected) {
    const question = dataset.questions[selected.index]!;
    if (question.question_id !== selected.question_id || classifyLongMemEvalDatasetCohort(question) !== selected.cohort) {
      throw new Error("frozen question or cohort changed");
    }
    const replayed = replay.rows.find((row) => row.question_id === selected.question_id)!;
    let outcome: "hit" | "miss" | "unknown" = "unknown";
    let measurementPath: string | null = null;
    let reason: string | null = replayed.status === "unavailable" ? replayed.reason : null;
    if (replayed.status === "replayed") {
      try {
        const directory = resolve(root, "questions", String(selected.index).padStart(5, "0"));
        if (replayed.publication_path !== join(directory, "publication.json")) throw new Error("question publication path changed");
        const publication = verifyDevelopmentQuestionPublication(frozen, selected, directory, readChainArtifact(replayed.publication_path));
        if (chainIdentity(publication) !== replayed.publication_identity) throw new Error("replayed question publication changed");
        const answerSessions = new Set(question.answer_session_ids);
        const goldSources = publication.sources.filter((source) => answerSessions.has(source.session_id));
        const gold = goldSources.filter((source) => source.admission === "admitted" && source.record_id !== undefined)
          .map((source) => SourceGoldUnitSchema.parse({ workspace_id: publication.workspace_id, root_kind: "source_record",
            root_id: source.record_id, source_version: source.source_version, content_digest: source.content_digest }));
        const measured = measureSemanticChain(replayed.chain_root, replayed.replay_path,
          [{ query_key: selected.query_key, source_units: gold }]);
        measurementPath = measured.path;
        const measurement = measured.result.rows[0]?.measurement;
        const metric = measurement?.status === "validated" ? measurement.metrics.mixed_kind_first_exposure.any_at_5 : undefined;
        const complete = publication.admitted_count === selected.source_manifest.length
          && [...answerSessions].every((id) => goldSources.some((source) => source.session_id === id && source.record_id !== undefined));
        if (metric?.status === "hit") outcome = "hit";
        else if (metric?.status === "miss" && complete) outcome = "miss";
        else reason = complete ? "native_measurement_unavailable" : "source_or_gold_mapping_incomplete";
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    }
    selectedRows.push({ index: selected.index, question_id: selected.question_id, cohort: selected.cohort, selected: true,
      outcome: selected.cohort === "abstention" ? "uncalibrated" as const : outcome,
      measurement_path: measurementPath, reason, mechanism: "not_exercised" as const });
  }
  const rows = frozen.inventory.map((entry) => ({ ...(selectedRows.find((row) => row.question_id === entry.question_id)
    ?? { ...entry, selected: false, outcome: "not_selected_development" as const,
      measurement_path: null, reason: null, mechanism: "not_exercised" as const }),
    abstention_calibration: entry.cohort === "abstention" ? "uncalibrated" : "not_applicable" }));
  const eligible = selectedRows.filter((row) => row.cohort === "answerable");
  const hits = eligible.filter((row) => row.outcome === "hit").length;
  const misses = eligible.filter((row) => row.outcome === "miss").length;
  const unknown = eligible.length - hits - misses;
  const totalEligible = frozen.inventory.filter((row) => row.cohort === "answerable").length;
  const result = { contract: "longmemeval-semantic-measurement-v1", freeze_identity: chainIdentity(frozen),
    replay_identity: chainIdentity(replay), dataset_sha256: frozen.config.dataset_sha256,
    exposure: frozen.exposure, metric: frozen.metric, order_policy: frozen.order_policy,
    mechanism: frozen.mechanism, provider_calls: 0,
    inventory: { questions: rows.length, answerable: totalEligible, abstention: rows.length - totalEligible },
    primary: { eligible: eligible.length, hits, misses, unknown,
      lower_bound: eligible.length === 0 ? null : hits / eligible.length,
      upper_bound: eligible.length === 0 ? null : (hits + unknown) / eligible.length,
      strict_over_90_required_hits: eligible.length === 0 ? null : Math.floor(0.9 * eligible.length) + 1, target_decision: "development_only" },
    formal_target: { eligible: totalEligible, strict_over_90_required_hits: totalEligible === 0 ? null : Math.floor(0.9 * totalEligible) + 1, status: "not_run" }, rows };
  const path = join(root, `measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result); return { path, result };
}
