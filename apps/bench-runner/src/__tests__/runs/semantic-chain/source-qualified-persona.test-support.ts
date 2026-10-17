import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { buildSourceReferenceCatalog, hashSourceRecordId, type SourceSemanticHandleDescriptor } from "@do-soul/alaya-protocol";
import { createSourceSemanticInterpretationPublication, EvidenceService, fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../../../core-daemon/src/runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../../../core-daemon/src/runtime/field/sqlite-field-formation-stores.js";
import { readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { atomicWriteJson, checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import * as datasetOwner from "../../../datasets/longmemeval/ingestion/fetch.js";
import { createTestLongMemEvalDatasetAuthority } from "../../longmemeval/ingestion/test-dataset-authority.js";
import { prepareSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/prepare.js";
import { createSourceRecordsSidecarWriter, inspectSourceRecordsArtifact, sealSourceRecordsManifest,
  sourceRecordsManifestPath, sourceRecordsSidecarPath, type SourceRecordsMessage } from "../../../runs/snapshot/source-records/contract.js";
import { admitRetainedNativeSourceSnapshot, readVerifiedNativeSourceSnapshot, sealNativeSourceRecordsSnapshotCopy }
  from "../../../runs/snapshot/source-records/native.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../../runs/selection/question-runtime-identity.js";
import { authoredProposal, correspondenceRaw, CAPTURE, type qualifiedSelectionFixture } from "./source-qualified-selection.test-support.js";

/** Authored source import through the actual parent/successor/native admission owners.
 * Only the existing test dataset capability is substituted; no official corpus is read. */
export async function qualifiedPersonaSuccessor(h: Awaited<ReturnType<typeof qualifiedSelectionFixture>>) {
  const dataDir = join(h.directory, "authored-dataset"), meta = join(h.directory, "authored-meta");
  mkdirSync(dataDir); mkdirSync(meta);
  const bodies = [...h.task.sources.map(row => row.body), ...Array.from({ length: 12 }, (_, i) => `Unqualified retained note ${i}.`)];
  const questionId = "qualified-persona-authored";
  const source = JSON.stringify([{ question_id: questionId, question_type: "fixture", question: h.task.original,
    answer: "unused authored metadata", question_date: "2026/09/18 (Fri) 00:00", answer_session_ids: [],
    haystack_session_ids: ["authored-session"], haystack_dates: ["2026/09/17 (Thu) 00:00"],
    haystack_sessions: [bodies.map(content => ({ role: "user", content }))] }]);
  const sha256 = createHash("sha256").update(source).digest("hex");
  writeFileSync(join(dataDir, "longmemeval_s.json"), source);
  writeFileSync(join(meta, "longmemeval_s.meta.json"), JSON.stringify({ sha256, size_bytes: Buffer.byteLength(source), question_count: 1 }));
  const parentPath = join(h.directory, "parent", "source.sqlite"), successorPath = join(h.directory, "successor", "source.sqlite");
  const common = { dataDir, pinnedMetaRoot: meta, offset: 0, limit: 1, producerCommit: "a".repeat(40) };
  await prepareSourceRecordsSnapshot({ ...common, snapshotPath: parentPath,
    dataDirRoot: join(h.directory, "parent", "seed"), recordedAt: "2026-09-24T00:00:00.000Z" });
  const load = datasetOwner.loadDatasetWindowWithIdentity;
  const authority = vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockImplementation(async (...args) => {
    const loaded = await load(...args);
    return { ...loaded, promotionAuthority: createTestLongMemEvalDatasetAuthority({ datasetSha256: loaded.sha256,
      questionInputs: loaded.questions, assignments: loaded.questions.map(row => ({ question_id: row.question_id, dataset_cohort: "answerable" })) }) };
  });
  let successor;
  try {
    successor = await prepareSourceRecordsSnapshot({ ...common, snapshotPath: successorPath,
      dataDirRoot: join(h.directory, "successor", "seed"), recordedAt: CAPTURE,
      personaSuccessor: { policy: "longmemeval-question-local-persona-v1", parentSnapshotPath: parentPath } });
  } finally { authority.mockRestore(); }
  const identity = buildLongMemEvalQuestionRuntimeIdentity(questionId), snapshot = join(h.directory, "persona-native.sqlite");
  const manifest = await admitRetainedNativeSourceSnapshot({ retainedPath: successorPath, expectedSha256: successor.db_sha256,
    snapshotPath: snapshot, workspaceId: identity.workspaceId, runId: identity.runId, producerCommit: common.producerCommit });
  const messages: SourceRecordsMessage[] = [];
  inspectSourceRecordsArtifact(successorPath, row => messages.push(row));
  const tuple = (record: SourceRecordsMessage["record"]) => ({ source_id: record.source_id, record_id: record.identity,
    source_version: record.source_version, content_digest: record.content_digest });
  h.input.config = { ...h.input.config, snapshot_path: snapshot, snapshot_sha256: manifest.db_sha256,
    workspace_id: identity.workspaceId, run_id: identity.runId };
  h.input.qualified_selection = { ...h.input.qualified_selection!, snapshot_identity: manifest.identity,
    snapshot_source_count: manifest.sources.length, persona_successor: { snapshot_path: successorPath, parent_snapshot_path: parentPath },
    nominees: messages.slice(0, 16).map((row, i) => ({ nominee: tuple(row.predecessor!), current: tuple(row.record), body_bytes: Buffer.byteLength(bodies[i]!) })) };
  return { parentPath, successorPath, messages };
}

/** Publish the same authored semantic content against the real successor records on a fresh copy.
 * No precomputed fixture proof is transferred: the consumer must compute its own Q/H/C proofs. */
export async function publishQualifiedPersonaInterpretations(h: Awaited<ReturnType<typeof qualifiedSelectionFixture>>) {
  const config = h.input.config, population = h.input.qualified_selection!;
  const native = readVerifiedNativeSourceSnapshot(config.snapshot_path);
  const working = join(h.directory, "persona-h-working.sqlite"), publishedPath = join(h.directory, "persona-h-published.sqlite");
  checkpointAndCopyBenchDb(config.snapshot_path, working);
  const database = initDatabase({ filename: working });
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const publication = createSourceSemanticInterpretationPublication({ stores, sha256: fieldContractSha256,
    evidenceService: new EvidenceService({ eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CAPTURE }) });
  const descriptors: SourceSemanticHandleDescriptor[] = [];
  try {
    for (const [index, authored] of h.task.sources.entries()) {
      const member = native.records.find(row => row.record.identity === population.nominees[index]!.current.record_id)!;
      expect(member.content_bytes).toBe(authored.body);
      const record = member.record, original = authored.package.proofs[0]!.interpretation;
      const interpretation = { ...original, source: { ...original.source, source_id: record.source_id,
        source_version: record.source_version, attribution_context: record.attribution_context! } };
      const locations = interpretation.source.assertion_locations!;
      const catalog = buildSourceReferenceCatalog(fieldContractSha256(authored.body), locations.map(row => ({ assertion_id: row.assertion_id,
        text: Buffer.from(authored.body).subarray(...row.source_utf8_span).toString("utf8") })), fieldContractSha256);
      const published = await publication.publish({ workspaceId: config.workspace_id, runId: config.run_id,
        artifactKey: record.source_id, source: member.content_bytes, attribution_context: record.attribution_context!,
        catalog, interpretation, assertion_locations: locations, provenance: { producer_id: "authored-persona-selection" } });
      expect(published.source_record).toEqual(record);
      const actual = published.bound.interpretation;
      descriptors.push({ interpretation_id: published.bound.interpretation_id, source_id: record.source_id,
        source_version: record.source_version, content_digest: record.content_digest, producer_id: actual.producer_id,
        producer_version: actual.producer_version, contract_version: actual.contract_version, interpretation: actual,
        source_disclosure: authored.package.source_disclosure });
    }
  } finally { database.close(); closeCachedDatabase(working); }
  checkpointAndCopyBenchDb(working, publishedPath);
  const manifest = sealNativeSourceRecordsSnapshotCopy(config.snapshot_path, publishedPath);
  h.input.config = { ...config, snapshot_path: publishedPath, snapshot_sha256: manifest.db_sha256 };
  population.snapshot_identity = manifest.identity;
  const q = readSemanticProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens)[0]!;
  if (q.received === undefined || !("query" in q.received)) throw new Error("authored Q receipt required");
  const correspondences = [];
  for (const [index, descriptor] of descriptors.entries()) {
    const cache = join(h.directory, `persona-c-${index}`);
    const workset = parseSemanticProposalWorkset({ ...config.query_workset, kind: "semantic_correspondence", items: [{
      original_query: h.task.original, admitted_query_semantics: q.received.query,
      source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: descriptor.interpretation }] }] });
    const c = await authoredProposal(workset, cache, correspondenceRaw);
    if (c.result.received === undefined || !("semantic_correspondence" in c.result.received)) throw new Error("authored C receipt required");
    correspondences.push(c.result.received.semantic_correspondence);
    population.nominees[index]!.interpretation = descriptor;
    population.nominees[index]!.correspondence = { workset, cache_root: cache, max_output_tokens: config.max_output_tokens, artifact: c.artifact };
  }
  return { descriptors, query: q.received.query, correspondences };
}

/** Produce a structurally valid, self-hashed sidecar lie without changing either real DB. */
export function forgePersonaPredecessor(snapshotPath: string) {
  const messages: SourceRecordsMessage[] = [];
  const artifact = inspectSourceRecordsArtifact(snapshotPath, row => messages.push(row));
  const { shards: _shards, message_count: _count, ...header } = artifact.sidecar;
  const writer = createSourceRecordsSidecarWriter(snapshotPath, header);
  const row = messages[0]!, old = { ...row.predecessor!, source_version: "forged-historical-version" };
  const predecessor = { ...old, identity: hashSourceRecordId(old, fieldContractSha256) };
  for (const [i, message] of messages.entries()) writer.append(i === 0 ? { ...message, predecessor } : message);
  writer.finish();
  const { manifest_sha256: _identity, ...body } = artifact.manifest;
  atomicWriteJson(sourceRecordsManifestPath(snapshotPath), sealSourceRecordsManifest({ ...body,
    sidecar_sha256: hashRegularFileNoFollow(sourceRecordsSidecarPath(snapshotPath)) }));
  return predecessor;
}
