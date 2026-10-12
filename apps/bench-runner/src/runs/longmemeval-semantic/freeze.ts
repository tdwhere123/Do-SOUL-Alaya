import { currentBenchScope, trackBenchOperation, refuseBenchWorkAfterCancel } from "../../harness/daemon-task.js";
import { AlayaError } from "@do-soul/alaya-protocol";
import { join } from "node:path";
import { requireLongMemEvalTimestamp } from "../../datasets/longmemeval/ingestion/source-time.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { classifyLongMemEvalDatasetCohort } from "../selection/dataset-cohort.js";
import { censusCompleteSourceRecords } from "../snapshot/source-records/census.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { chainIdentity, readChainArtifact, writeChainArtifact, writeChainJson } from "../semantic-chain/contract.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset, semanticProposalWorksetContract } from "../semantic-proposal/workset.js";
import { LongMemEvalExperimentConfigSchema, LongMemEvalExperimentFreezeSchema, loadFrozenLongMemEvalDataset,
  longMemEvalFreezePath } from "./contract.js";
import { NATIVE_SEMANTIC_ROUTE, freezeSourceCaches, assertSourceCaches } from "./native-arm.js";

/** Freezes original dataset identities and context before any query-semantics outputs; never dispatches a provider. */
export async function freezeLongMemEvalSemanticRun(value: unknown, root: string) {
  const scope = currentBenchScope();
  const freeze = () => freezeBoundLongMemEvalSemanticRun(value, root);
  return scope === undefined ? freeze() : trackBenchOperation(scope, freeze);
}

async function freezeBoundLongMemEvalSemanticRun(value: unknown, root: string) {
  refuseBenchWorkAfterCancel();
  const config = LongMemEvalExperimentConfigSchema.parse(value);
  if (new Set(config.question_ids).size !== config.question_ids.length) throw new AlayaError("VALIDATION", "development question IDs repeat");
  if (config.stage !== "formal" && config.question_ids.length > 50) throw new AlayaError("VALIDATION", "development selection exceeds 50 questions");
  if (config.stage === "formal" && config.previously_exposed_question_ids === undefined) {
    throw new AlayaError("VALIDATION", "formal freeze requires explicit prior development exposure");
  }
  return withSnapshotPublishLock(longMemEvalFreezePath(root), async () => {
    const loaded = await loadFrozenLongMemEvalDataset(config);
    refuseBenchWorkAfterCancel();
    const existing = readChainArtifact(longMemEvalFreezePath(root));
    if (existing !== undefined) {
      const frozen = LongMemEvalExperimentFreezeSchema.parse(existing);
      if (chainIdentity(frozen.config) !== chainIdentity(config)
        || frozen.implementation_revision !== readCurrentExtractionAuthorityRevision()) throw new AlayaError("CONFLICT", "development freeze changed");
      if (frozen.contract === "longmemeval-native-semantic-v3") assertSourceCaches(frozen.source_caches);
      writeChainJson(join(root, "query-workset.json"), frozen.query_workset);
      return frozen;
    }
    const inventory = loaded.questions.map((question, index) => ({ index, question_id: question.question_id,
      cohort: classifyLongMemEvalDatasetCohort(question) }));
    if (new Set(inventory.map((row) => row.question_id)).size !== inventory.length) throw new AlayaError("VALIDATION", "dataset question IDs repeat");
    if (config.stage === "formal" && (config.question_ids.length !== inventory.length
      || inventory.some(row => !config.question_ids.includes(row.question_id)))) {
      throw new AlayaError("VALIDATION", "formal selection must contain the entire original dataset, including abstention rows");
    }
    const exposed = config.previously_exposed_question_ids ?? [];
    if (new Set(exposed).size !== exposed.length || exposed.some(id => !inventory.some(row => row.question_id === id))) {
      throw new AlayaError("VALIDATION", "prior exposure must name unique original dataset questions");
    }
    const selected = [];
    for (const id of config.question_ids) {
      const row = inventory.find((entry) => entry.question_id === id);
      if (row === undefined) throw new AlayaError("VALIDATION", "development selection is absent from original dataset");
      const question = loaded.questions[row.index]!;
      const census = await censusCompleteSourceRecords({ population: "longmemeval_s", dataDir: config.data_dir,
        pinnedMetaRoot: config.pinned_meta_root, questionWindow: { offset: row.index, limit: 1 } });
      refuseBenchWorkAfterCancel();
      selected.push({ ...row, question: question.question, question_date: question.question_date,
        interpretation_clock: requireLongMemEvalTimestamp(question.question_date),
        source_manifest: census.records.map(({ source_id, source_version, content_digest, corpus_digest,
          session_id, session_index, round_index, source_observed_at, roles }) => ({ source_id, source_version,
          content_digest, corpus_digest, session_id, session_index, round_index, source_observed_at, roles })) });
    }
    const query_workset = parseSemanticProposalWorkset({ contract: semanticProposalWorksetContract(config.request_profile), kind: "query",
      model: config.model, provider_url: config.provider_url, request_profile: config.request_profile, items: selected.map((row) => ({
        original_query: row.question, approved_fixed_context: {
          context_id: `longmemeval_s:${row.question_id}:${config.dataset_sha256}`,
          notes: `Question date: ${row.question_date}. Interpretation clock: ${row.interpretation_clock}.`
        }
      })) });
    const lines = materializeSemanticProposalLines(query_workset, config.max_output_tokens);
    const arm = "arm" in config ? { contract: "longmemeval-native-semantic-v3",
      metric: "source-bearing-union-first-exposure-any-at-k-v1", mechanism: "native_source_interpretation_and_semantic_correspondence",
      order_policy: NATIVE_SEMANTIC_ROUTE.order.enumeration_policy,
      native_route: NATIVE_SEMANTIC_ROUTE, source_caches: freezeSourceCaches(config.source_cache_roots) }
      : { contract: "longmemeval-semantic-development-v3", metric: "session-bearing-source-round-mixed-any-at-5",
        order_policy: "native_canonical_source_root_order",
        mechanism: "source_only_interpretation_and_correspondence_not_exercised" };
    const frozen = LongMemEvalExperimentFreezeSchema.parse({ ...arm, config,
      implementation_revision: readCurrentExtractionAuthorityRevision(),
      exposure: config.stage === "formal" ? "formal_with_recorded_development_exposure" : "development_exposed",
      inventory, selected: selected.map((row, index) => ({ ...row, query_key: lines[index]!.key })), query_workset });
    writeChainArtifact(longMemEvalFreezePath(root), frozen);
    writeChainJson(join(root, "query-workset.json"), query_workset);
    return frozen;
  });
}
