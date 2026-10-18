import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { buildSourceReferenceCatalog, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, sourceSemanticInterpretationIdentity,
  UNKNOWN_UTTERANCE_ATTRIBUTION, type SourceSemanticHandleDescriptor } from "@do-soul/alaya-protocol";
import { createSourceSemanticInterpretationPublication, EvidenceService, fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { parseSourceSemanticRequest, receiveSourceSemantics, type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { createDaemonFieldRepos } from "../../../../../core-daemon/src/runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../../../core-daemon/src/runtime/field/sqlite-field-formation-stores.js";
import * as datasetOwner from "../../../datasets/longmemeval/ingestion/fetch.js";
import { createTestLongMemEvalDatasetAuthority } from "../../longmemeval/ingestion/test-dataset-authority.js";
import { prepareSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/prepare.js";
import { admitRetainedNativeSourceSnapshot, readVerifiedNativeSourceSnapshot, sealNativeSourceRecordsSnapshotCopy }
  from "../../../runs/snapshot/source-records/native.js";
import { censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { nativeSourceRequestInventory } from "../../../runs/extraction/fill/source-request-workset.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../../runs/selection/question-runtime-identity.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createCorrespondenceTaskPresentationContext, CORRESPONDENCE_TASK_PRESENTATION } from "../../../runs/semantic-proposal/correspondence-model-view.js";
import { createSourceRecordsSidecarWriter, inspectSourceRecordsArtifact, sealSourceRecordsManifest,
  sourceRecordsManifestPath, sourceRecordsSidecarPath, sourceRecordsArtifactInputPaths,
  type SourceRecordsMessage } from "../../../runs/snapshot/source-records/contract.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { authoredProposal } from "./source-qualified-selection.test-support.js";
import { interpretedQueryRaw } from "../../longmemeval/query-producer-fixture.js";
import { assessmentForTestPairs } from "../../support/semantic-correspondence-assessment.js";

export const TOKENS = 16384, TIME = "2026-09-25T00:00:00.000Z", QUESTION = "What did you choose?";
export const GENERATION = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
  provider_url: "https://generativelanguage.googleapis.com" };

/** New authored bytes only. The test dataset capability is the only substituted admission;
 * import, source identity/audit, frozen SQLite, retained seals and H publication are real. */
export async function taskPresentationFixture(root: string) {
  const dataDir = join(root, "dataset"), meta = join(root, "meta"); mkdirSync(dataDir); mkdirSync(meta);
  const questionId = "authored-task-perspective", identity = buildLongMemEvalQuestionRuntimeIdentity(questionId);
  const bodies = ["I chose amber.", "Assistant: I chose violet.", "I chose tea."];
  const source = JSON.stringify([{ question_id: questionId, question_type: "fixture", question: QUESTION,
    answer: "unused authored metadata", question_date: "2026/09/18 (Fri) 00:00", answer_session_ids: [],
    haystack_session_ids: ["actual-a", "actual-b"], haystack_dates: ["2026/09/16 (Wed) 00:00", "2026/09/17 (Thu) 00:00"],
    haystack_sessions: [[{ role: "assistant", content: bodies[0] }, { role: "user", content: bodies[1] }],
      [{ role: "assistant", content: bodies[2] }]] }]);
  const datasetSha = createHash("sha256").update(source).digest("hex");
  writeFileSync(join(dataDir, "longmemeval_s.json"), source);
  writeFileSync(join(meta, "longmemeval_s.meta.json"), JSON.stringify({ sha256: datasetSha, size_bytes: Buffer.byteLength(source), question_count: 1 }));
  const parent = join(root, "parent", "source.sqlite"), retained = join(root, "retained", "source.sqlite");
  const common = { dataDir, pinnedMetaRoot: meta, offset: 0, limit: 1, producerCommit: "a".repeat(40),
    importEffects: { configDirectoryRoot: root, sqliteWriteQueue: "disabled" as const,
      embeddingStartupProbe: "omit" as const, gardenCompute: "disabled" as const } };
  const parentManifest = await prepareSourceRecordsSnapshot({ ...common, snapshotPath: parent, dataDirRoot: join(root, "parent-seed"), recordedAt: "2026-09-24T00:00:00.000Z" });
  const load = datasetOwner.loadDatasetWindowWithIdentity;
  const authority = vi.spyOn(datasetOwner, "loadDatasetWindowWithIdentity").mockImplementation(async (...args) => {
    const loaded = await load(...args);
    return { ...loaded, promotionAuthority: createTestLongMemEvalDatasetAuthority({ datasetSha256: loaded.sha256,
      questionInputs: loaded.questions, assignments: loaded.questions.map(q => ({ question_id: q.question_id, dataset_cohort: "answerable" })) }) };
  });
  let successor;
  try {
    successor = await prepareSourceRecordsSnapshot({ ...common, snapshotPath: retained, dataDirRoot: join(root, "retained-seed"), recordedAt: TIME,
      personaSuccessor: { policy: "longmemeval-question-local-persona-v1", parentSnapshotPath: parent } });
  } finally { authority.mockRestore(); }
  const parentNativePath = join(root, "parent-native.sqlite");
  const parentNative = await admitRetainedNativeSourceSnapshot({ retainedPath: parent, expectedSha256: parentManifest.db_sha256, snapshotPath: parentNativePath,
    workspaceId: identity.workspaceId, runId: identity.runId, producerCommit: common.producerCommit });
  const initial = join(root, "native.sqlite");
  await admitRetainedNativeSourceSnapshot({ retainedPath: retained, expectedSha256: successor.db_sha256, snapshotPath: initial,
    workspaceId: identity.workspaceId, runId: identity.runId, producerCommit: common.producerCommit });
  const descriptors = await publishAuthoredInterpretations(initial, root, identity);
  const snapshot = join(root, "published.sqlite"), manifest = sealNativeSourceRecordsSnapshotCopy(initial, snapshot);
  const selection = { contract: CORRESPONDENCE_TASK_PRESENTATION, snapshot_path: snapshot, snapshot_identity: manifest.identity,
    question_id: questionId, ...taskPresentationOccurrencePins(retained) };
  const qRoot = join(root, "q-cache");
  const { q, qWorkset, query } = await authoredTaskQuery(selection, qRoot);
  const cWorkset = (index = 0, selected = true) => parseSemanticProposalWorkset({ ...qWorkset, kind: "semantic_correspondence", items: [{
    original_query: QUESTION, admitted_query_semantics: query,
    source_interpretation_descriptors: [{ source_interpretation_id: descriptors[index]!.interpretation_id, interpretation: descriptors[index]!.interpretation }],
    ...(selected ? { selected_model_view: selection } : {}) }] });
  const config = { snapshot_path: snapshot, snapshot_sha256: manifest.db_sha256, workspace_id: identity.workspaceId, run_id: identity.runId,
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-18T00:00:00.000Z",
    query_workset: qWorkset, query_cache_root: qRoot, correspondence_cache_root: join(root, "c-cache"), max_output_tokens: TOKENS,
    correspondence_model_view: selection, discovery_page_cap: 1, correspondence_pair_cap: 3, access_policy: "canonical-v1" as const,
    budget: { schema_version: 1 as const, work_units: 10_000_000, memory_bytes: 200_000_000,
      page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 },
    authorized_scopes: { mode: "named" as const, scopes: ["project"] }, output_byte_limit: 1_000_000 };
  return { root, parent, parentNative, parentNativePath, retained, snapshot, selection, manifest, datasetSha, config, descriptors, query, q, cWorkset };
}

async function authoredTaskQuery(selection: Parameters<typeof createCorrespondenceTaskPresentationContext>[0], cache: string) {
  const context = createCorrespondenceTaskPresentationContext(selection);
  const qWorkset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query", ...GENERATION,
    items: [{ original_query: QUESTION, approved_fixed_context: context }] });
  const q = await authoredProposal(qWorkset, cache, () => interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [{ kind: "statement", key: "choice", predicate: "choose", arguments: [
      { role: "agent", target: { kind: "named", key: "speaker", excerpt: "you" }, excerpt: "you" },
      { role: "theme", target: { kind: "free", key: "chosen", return: true }, excerpt: "What" }] }] }], gaps: [] }));
  if (q.result.received === undefined || !("query" in q.result.received) || q.result.received.query === undefined) throw new Error("authored Q missing");
  return { q, qWorkset, query: q.result.received.query };
}

/** A separately authored Q/H view of the real original unknown-attribution snapshot. */
export async function unknownTaskPresentationFixture(h: Awaited<ReturnType<typeof taskPresentationFixture>>) {
  const parent = readVerifiedNativeSourceSnapshot(h.parentNativePath);
  const selection = { ...h.selection, snapshot_path: h.parentNativePath, snapshot_identity: h.parentNative.identity,
    ...taskPresentationOccurrencePins(h.parent) };
  const cache = join(h.root, "unknown-q-cache"), { q, qWorkset, query } = await authoredTaskQuery(selection, cache);
  const descriptors = h.descriptors.map(descriptor => {
    const record = parent.records.find(member => member.source_id === descriptor.source_id)!.record;
    const interpretation = { ...descriptor.interpretation!, source: { ...descriptor.interpretation!.source,
      source_version: record.source_version, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION } };
    return { ...descriptor, source_version: record.source_version, interpretation,
      interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256) };
  });
  const cWorkset = (index = 0, selected = true) => parseSemanticProposalWorkset({ ...qWorkset, kind: "semantic_correspondence", items: [{
    original_query: QUESTION, admitted_query_semantics: query,
    source_interpretation_descriptors: [{ source_interpretation_id: descriptors[index]!.interpretation_id, interpretation: descriptors[index]!.interpretation }],
    ...(selected ? { selected_model_view: selection } : {}) }] });
  return { ...h, selection, query, q, descriptors, cWorkset, snapshot: h.parentNativePath, manifest: h.parentNative, retained: h.parent,
    config: { ...h.config, snapshot_path: h.parentNativePath, snapshot_sha256: h.parentNative.db_sha256,
      query_workset: qWorkset, query_cache_root: cache, correspondence_model_view: selection } };
}

export function taskPresentationOccurrencePins(path: string) {
  const { manifest } = inspectSourceRecordsArtifact(path), parent = manifest.persona_successor;
  return { retained_manifest_sha256: manifest.manifest_sha256, retained_sidecar_sha256: manifest.sidecar_sha256,
    persona_parent: parent === undefined ? null : { snapshot_path: parent.parent_snapshot, manifest_sha256: parent.parent_manifest_sha256 } };
}

/** Change only authored question-header bytes, including invalid inputs for fail-closed checks. */
export async function withResealedTaskQuestionHeader(path: string, change: (header: Record<string, unknown>) => void,
  check: () => Promise<void>) {
  const artifact = inspectSourceRecordsArtifact(path);
  const indexPath = sourceRecordsSidecarPath(path), manifestPath = sourceRecordsManifestPath(path);
  const index = readFileSync(indexPath), manifest = readFileSync(manifestPath);
  try {
    const header: Record<string, unknown> = structuredClone(artifact.sidecar);
    change(header);
    writeFileSync(indexPath, JSON.stringify(header));
    const { manifest_sha256: _old, ...body } = artifact.manifest;
    writeFileSync(manifestPath, JSON.stringify(sealSourceRecordsManifest({ ...body,
      sidecar_sha256: hashRegularFileNoFollow(indexPath) })));
    await check();
  } finally { writeFileSync(indexPath, index); writeFileSync(manifestPath, manifest); }
}

/** Reseal only authored occurrence metadata; restore the original files even on a failing assertion. */
export async function withResealedTaskOccurrences(path: string, change: (rows: SourceRecordsMessage[]) => void, check: () => Promise<void>) {
  const messages: SourceRecordsMessage[] = [], artifact = inspectSourceRecordsArtifact(path, row => messages.push(row));
  const indexPath = sourceRecordsSidecarPath(path), manifestPath = sourceRecordsManifestPath(path);
  const index = readFileSync(indexPath), manifest = readFileSync(manifestPath), originalPaths = new Set(sourceRecordsArtifactInputPaths(path));
  try {
    change(messages);
    const { shards: _shards, message_count: _count, ...header } = artifact.sidecar;
    const writer = createSourceRecordsSidecarWriter(path, header);
    for (const row of messages) writer.append(row);
    const sidecar = writer.finish(), { manifest_sha256: _old, ...body } = artifact.manifest;
    writeFileSync(manifestPath, JSON.stringify(sealSourceRecordsManifest({ ...body, message_count: sidecar.message_count,
      sidecar_sha256: hashRegularFileNoFollow(indexPath) })));
    await check();
  } finally {
    writeFileSync(indexPath, index); writeFileSync(manifestPath, manifest);
    for (const added of sourceRecordsArtifactInputPaths(path)) if (!originalPaths.has(added)) rmSync(added);
  }
}

async function publishAuthoredInterpretations(initial: string, root: string, identity: { workspaceId: string; runId: string }) {
  const census = censusNativeSourceRecords({ population: "authored-task-presentation", snapshotPath: initial });
  const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, { model: GENERATION.model,
    requestProfile: "gemini-3.1-minimal-v1", sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION });
  const native = readVerifiedNativeSourceSnapshot(initial), working = join(root, "working.sqlite");
  checkpointAndCopyBenchDb(initial, working);
  const database = initDatabase({ filename: working });
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const publication = createSourceSemanticInterpretationPublication({ stores, sha256: fieldContractSha256,
    evidenceService: new EvidenceService({ eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => TIME }) });
  const descriptors: SourceSemanticHandleDescriptor[] = [];
  try {
    // Preserve import order independently of census's source-id order.
    for (const member of native.records) {
      const source = census.records.find(row => row.source_id === member.source_id)!;
      const line = inventory.requests.find(row => row.sourceCorpus === member.content_bytes)!.line;
      const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
      const choice = source.content_bytes.includes("amber") ? "amber" : source.content_bytes.includes("violet") ? "violet" : "tea";
      const received = receiveSourceSemantics(JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
        content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "choice" } }],
          entities: [{ form: "entity", key: "speaker", semantic_key: "speaker", mentions: [{ assertion_id: 1, text: "I" }] },
            { form: "selection", key: "chosen", selection: { assertion_id: 1, text: choice } }],
          nodes: [{ kind: "statement", key: "choice", predicate: { kind: "explicit", reading: "choose", support: { assertion_id: 1, text: "chose" } },
            arguments: [{ role: "agent", target: { kind: "entity_ref", key: "speaker" } },
              { role: "theme", target: { kind: "entity_ref", key: "chosen" } }], qualifications: [] }], gaps: [] } }), request, {
        sourceCorpus: source.content_bytes, source_id: source.source_id, source_version: source.source_version,
        sourceRole: source.source_role, sourceScope: "complete-source", attribution_context: source.attribution_context,
        assertionIds: request.source_request.source_assertions.map(row => row.assertion_id), ...request.source_request.producer_capability });
      expect(received.outcome.status).toBe("interpreted");
      if (received.interpretation === undefined) throw new Error("authored H missing");
      const h = received.interpretation, locations = h.source.assertion_locations!;
      const catalog = buildSourceReferenceCatalog(fieldContractSha256(source.content_bytes), request.source_request.source_assertions, fieldContractSha256);
      const published = await publication.publish({ ...identity, artifactKey: source.source_id, source: source.content_bytes,
        attribution_context: source.attribution_context!, catalog, interpretation: h, assertion_locations: locations,
        provenance: { producer_id: "authored-task-presentation" } });
      expect(published.source_record).toEqual(member.record);
      descriptors.push({ interpretation_id: published.bound.interpretation_id, source_id: source.source_id,
        source_version: source.source_version, content_digest: member.record.content_digest,
        producer_id: h.producer_id, producer_version: h.producer_version, contract_version: h.contract_version,
        interpretation: published.bound.interpretation });
    }
  } finally { database.close(); closeCachedDatabase(working); }
  checkpointAndCopyBenchDb(working, join(root, "published.sqlite"));
  return descriptors;
}

export function assessmentRaw(prompt: string) {
  const wire = JSON.parse(prompt), request = (wire.native_request ?? wire) as SourceSemanticCorrespondenceRequest;
  const h = request.source_interpretation_descriptors[0]!.interpretation;
  const query = request.catalog.query_endpoints.find(row => row.kind === "referent" && row.variable === request.admitted_query_semantics.variables.find(v => v.reference?.excerpt === "you")?.id)!;
  const referent = h.referents.find(row => row.mentions.some(id => h.mentions.find(m => m.id === id)?.text === "I"))!;
  const source = request.catalog.source_endpoints.find(row => row.kind === "referent" && row.referent === referent.id)!;
  return JSON.stringify({ contract: "source-semantic-correspondence-response-v5", outcome: { status: "interpreted", gaps: [] },
    semantic_correspondence: { contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
      assessments: assessmentForTestPairs(request.catalog, request.original_query, [{ query: query.handle, source: source.handle, query_excerpt: "you",
        source_semantic_support: [{ kind: "lexical", mentions: referent.mentions }] }]) } });
}

export function selectedLine(h: Awaited<ReturnType<typeof taskPresentationFixture>>, index = 0) {
  return materializeSemanticProposalLines(h.cWorkset(index), TOKENS)[0]!;
}
