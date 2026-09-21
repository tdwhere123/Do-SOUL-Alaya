import { join } from "node:path";
import { requireLongMemEvalTimestamp } from "../../datasets/longmemeval/ingestion/source-time.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { classifyLongMemEvalDatasetCohort } from "../selection/dataset-cohort.js";
import { censusCompleteSourceRecords } from "../snapshot/source-records/census.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { chainIdentity, readChainArtifact, writeChainArtifact, writeChainJson } from "../semantic-chain/contract.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { LongMemEvalSemanticConfigSchema, LongMemEvalSemanticFreezeSchema, loadFrozenLongMemEvalDataset } from "./contract.js";

/** Freezes original dataset identities and context before any Q outputs; never dispatches a provider. */
export async function freezeLongMemEvalSemanticRun(value: unknown, root: string) {
  const config = LongMemEvalSemanticConfigSchema.parse(value);
  if (new Set(config.question_ids).size !== config.question_ids.length) throw new Error("development question IDs repeat");
  if (config.stage !== "formal" && config.question_ids.length > 50) throw new Error("development selection exceeds 50 questions");
  if (config.stage === "formal" && config.previously_exposed_question_ids === undefined) {
    throw new Error("formal freeze requires explicit prior development exposure");
  }
  return withSnapshotPublishLock(join(root, "freeze.json"), async () => {
    const loaded = await loadFrozenLongMemEvalDataset(config);
    const existing = readChainArtifact(join(root, "freeze.json"));
    if (existing !== undefined) {
      const frozen = LongMemEvalSemanticFreezeSchema.parse(existing);
      if (chainIdentity(frozen.config) !== chainIdentity(config)
        || frozen.implementation_revision !== readCurrentExtractionAuthorityRevision()) throw new Error("development freeze changed");
      writeChainJson(join(root, "query-workset.json"), frozen.query_workset);
      return frozen;
    }
    const inventory = loaded.questions.map((question, index) => ({ index, question_id: question.question_id,
      cohort: classifyLongMemEvalDatasetCohort(question) }));
    if (new Set(inventory.map((row) => row.question_id)).size !== inventory.length) throw new Error("dataset question IDs repeat");
    if (config.stage === "formal" && (config.question_ids.length !== inventory.length
      || inventory.some(row => !config.question_ids.includes(row.question_id)))) {
      throw new Error("formal selection must contain the entire original dataset, including abstention rows");
    }
    const exposed = config.previously_exposed_question_ids ?? [];
    if (new Set(exposed).size !== exposed.length || exposed.some(id => !inventory.some(row => row.question_id === id))) {
      throw new Error("prior exposure must name unique original dataset questions");
    }
    const selected = [];
    for (const id of config.question_ids) {
      const row = inventory.find((entry) => entry.question_id === id);
      if (row === undefined) throw new Error("development selection is absent from original dataset");
      const question = loaded.questions[row.index]!;
      const census = await censusCompleteSourceRecords({ population: "longmemeval_s", dataDir: config.data_dir,
        pinnedMetaRoot: config.pinned_meta_root, questionWindow: { offset: row.index, limit: 1 } });
      selected.push({ ...row, question: question.question, question_date: question.question_date,
        interpretation_clock: requireLongMemEvalTimestamp(question.question_date),
        source_manifest: census.records.map(({ source_id, source_version, content_digest, corpus_digest,
          session_id, session_index, round_index, source_observed_at, roles }) => ({ source_id, source_version,
          content_digest, corpus_digest, session_id, session_index, round_index, source_observed_at, roles })) });
    }
    const query_workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v1", kind: "query",
      model: config.model, request_profile: config.request_profile, items: selected.map((row) => ({
        original_query: row.question, approved_fixed_context: {
          context_id: `longmemeval_s:${row.question_id}:${config.dataset_sha256}`,
          notes: `Question date: ${row.question_date}. Interpretation clock: ${row.interpretation_clock}.`
        }
      })) });
    const lines = materializeSemanticProposalLines(query_workset, config.max_output_tokens);
    const frozen = LongMemEvalSemanticFreezeSchema.parse({ contract: "longmemeval-semantic-development-v1", config,
      implementation_revision: readCurrentExtractionAuthorityRevision(), metric: "session-bearing-source-round-mixed-any-at-5",
      order_policy: "native_canonical_source_root_order", mechanism: "source_only_h_a_not_exercised",
      exposure: config.stage === "formal" ? "formal_with_recorded_development_exposure" : "development_exposed",
      inventory, selected: selected.map((row, index) => ({ ...row, query_key: lines[index]!.key })), query_workset });
    writeChainArtifact(join(root, "freeze.json"), frozen);
    writeChainJson(join(root, "query-workset.json"), query_workset);
    return frozen;
  });
}
