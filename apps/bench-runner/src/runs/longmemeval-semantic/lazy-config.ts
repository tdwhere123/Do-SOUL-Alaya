import { resolve, join } from "node:path";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainJson } from "../semantic-chain/contract.js";
import { verifySemanticChainQueries } from "../semantic-chain/inputs.js";
import { admitNativeLazyConfig } from "../semantic-chain/bind-lazy.js";
import { readLongMemEvalSemanticFreeze, loadFrozenLongMemEvalDataset } from "./contract.js";
import { ExperimentPreparedSchema, verifyLongMemEvalQuestionPublication,
  verifyLongMemEvalQuestionChain } from "./execute.js";

export type LongMemEvalLazyConfigInput = Readonly<{
  root: string;
  preparedPath: string;
  sourcePreflightPath: string;
  sourceCacheRoot: string;
}>;

async function readInitialQuestion(input: LongMemEvalLazyConfigInput) {
  const frozen = readLongMemEvalSemanticFreeze(input.root);
  if (frozen.contract !== "longmemeval-native-semantic-v3" || frozen.selected.length !== 1 ||
      frozen.query_workset.items.length !== 1 || frozen.config.question_ids.length !== 1) {
    throw new AlayaError("VALIDATION", "lazy LongMemEval entry requires one native semantic question");
  }
  const selected = frozen.selected[0]!;
  const prepared = ExperimentPreparedSchema.parse(readChainArtifact(input.preparedPath));
  if (prepared.contract !== "longmemeval-native-semantic-prepared-v1" ||
      prepared.freeze_identity !== chainIdentity(frozen) || prepared.rows.length !== 1 ||
      prepared.rows[0]?.question_id !== selected.question_id ||
      resolve(input.preparedPath) !== resolve(input.root, `prepared-${chainIdentity(prepared)}.json`)) {
    throw new AlayaError("CONFLICT", "initial prepared question differs from the native freeze");
  }
  const row = prepared.rows[0]!;
  if (row.status !== "prepared") throw new AlayaError("UNAVAILABLE", "initial question publication is unavailable");
  const directory = resolve(input.root, "questions", String(selected.index).padStart(5, "0"));
  if (resolve(row.publication_path) !== join(directory, "publication.json")) {
    throw new AlayaError("CONFLICT", "initial question publication belongs to another root");
  }
  const publication = verifyLongMemEvalQuestionPublication(frozen, selected, directory,
    readChainArtifact(row.publication_path));
  if (chainIdentity(publication) !== row.publication_identity ||
      publication.admitted_count !== selected.source_manifest.length ||
      publication.sources.some(source => source.admission !== "admitted" || source.record_id === undefined)) {
    throw new AlayaError("CONFLICT", "initial publication does not admit the full original source census");
  }
  verifyLongMemEvalQuestionChain(frozen, selected, directory, publication, row.chain_root);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(row.chain_root, "prepare.json")));
  verifySemanticChainQueries(plan);
  if (plan.queries.length !== 1 || plan.queries[0]?.query_key !== selected.query_key) {
    throw new AlayaError("CONFLICT", "initial prepared query differs from the frozen original question");
  }
  if (plan.queries[0].status === "raw_ready" &&
      ["pending", "unknown"].includes(plan.queries[0].reason)) {
    throw new AlayaError("UNAVAILABLE", "query producer outcome must settle before the source window");
  }
  const sidecar: unknown = JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: `${publication.snapshot_path}.publication.json`, maxBytes: 32 * 1024 * 1024,
    label: "initial question source publication" }));
  if (chainIdentity(sidecar) !== chainIdentity(publication)) {
    throw new AlayaError("CONFLICT", "initial source publication sidecar differs from its prepared question");
  }
  const dataset = await loadFrozenLongMemEvalDataset(frozen.config);
  if (dataset.questions[selected.index]?.question_id !== selected.question_id) {
    throw new AlayaError("CONFLICT", "frozen question index changed");
  }
  const population = { name: "longmemeval_s", dataDir: frozen.config.data_dir,
    pinnedMetaRoot: frozen.config.pinned_meta_root, questionWindow: { offset: selected.index, limit: 1 as const } };
  return { frozen, selected, prepared, publication, plan, population, chainRoot: row.chain_root };
}

/** Dataset adapter retains freeze admission while sharing native Q and source binding. */
export async function admitLongMemEvalLazyConfig(input: LongMemEvalLazyConfigInput) {
  const initial = await readInitialQuestion(input);
  const { frozen, selected, prepared, publication, plan, population, chainRoot } = initial;
  if (frozen.config.source_cache_roots.length !== 1 ||
      resolve(input.sourceCacheRoot) !== resolve(frozen.config.source_cache_roots[0]!)) {
    throw new AlayaError("CONFLICT", "source owner cache root differs from the frozen question root");
  }
  const bound = await admitNativeLazyConfig({ plan, initialChainRoot: chainRoot, population,
    sourcePreflightPath: input.sourcePreflightPath,
    sourceCacheRoot: input.sourceCacheRoot, recordedAt: frozen.config.recorded_at,
    producerCommit: frozen.config.producer_commit });
  const projected = bound.census.records.map(({ source_id, source_version, content_digest, corpus_digest,
    session_id, session_index, round_index, source_observed_at, roles }) => ({ source_id, source_version,
    content_digest, corpus_digest, session_id, session_index, round_index, source_observed_at, roles }));
  if (bound.census.dataset_sha256 !== frozen.config.dataset_sha256 ||
      canonicalJson(projected) !== canonicalJson(selected.source_manifest)) {
    throw new AlayaError("CONFLICT", "source owner differs from the complete frozen question census");
  }
  const { publication: _publication, census: _census, sourceOwners: _sourceOwners, ...binding } = bound;
  return { ...binding, freeze_identity: chainIdentity(frozen), prepared_identity: chainIdentity(prepared),
    publication_identity: chainIdentity(publication), question_id: selected.question_id,
    question_index: selected.index };
}

export async function writeLongMemEvalLazyConfig(input: LongMemEvalLazyConfigInput, outputPath: string) {
  const bound = await admitLongMemEvalLazyConfig(input);
  writeChainJson(outputPath, bound.config);
  return { ...bound, path: outputPath };
}
