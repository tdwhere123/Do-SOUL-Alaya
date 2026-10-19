import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { buildSourceReferenceCatalog, canonicalJson, UNKNOWN_UTTERANCE_ATTRIBUTION,
  SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, type SourceSemanticCorrespondence,
  type SourceSemanticHandleDescriptor } from "@do-soul/alaya-protocol";
import { createSourceSemanticInterpretationPublication, EvidenceService, fieldContractSha256,
  deriveAddressableSpanViews, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { createDaemonFieldRepos } from "../../../../../core-daemon/src/runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../../../core-daemon/src/runtime/field/sqlite-field-formation-stores.js";
import { alternativeSelectionFixture, deploymentStatement, selectionExecutionBudget }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { correspondenceAssessmentJson } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { admitRetainedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { canonicalPath } from "../../../runs/fs/opened-contained-path.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { syntheticGeminiBody } from "../semantic-proposal/gemini-response-evidence.test-support.js";
import { interpretedQueryRaw } from "../../longmemeval/query-producer-fixture.js";
import { captureSourceAcquisitionLaunchBinding, type SourceAcquisitionExperimentInput } from "../../../runs/semantic-chain/source-acquisition-experiment.js";

export const CLOCK = "2026-09-18T00:00:00.000Z", CAPTURE = "2026-09-25T00:00:00.000Z";
const MODEL = "gemini-3.1-flash-lite", PROFILE = "gemini-3.1-minimal-v1", URL = "https://generativelanguage.googleapis.com";
const TOKENS = 16384, WS = "qualified-authored", RUN = "qualified-run";
/** Authored producer artifacts travel through the actual reservation, raw, receiver and admission owners.
 * The injected extractor returns authored strings only; it never performs a provider/model call. */
export async function authoredProposal(workset: ReturnType<typeof parseSemanticProposalWorkset>, root: string, raw: (prompt: string) => string) {
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, root, TOKENS, 1),
    inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  await executeSemanticProposalFill({ workset, cacheRoot: root, authority,
    config: { model: MODEL, requestProfile: PROFILE, providerUrl: URL, apiKey: null },
    extractor: { extract: async ({ userPrompt }) => {
      const rawJson = raw(userPrompt);
      return { rawJson, responseMetadata: { finishReason: "STOP" },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, responseBody: syntheticGeminiBody(rawJson, "STOP",
          { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) };
    } } });
  const result = readSemanticProposalResults(workset, root, TOKENS)[0]!;
  expect(result.status, canonicalJson(result)).toBe("interpreted");
  const artifact = { key: result.line.key, cache_identity: chainIdentity(result.shard),
    historical_production: { status: "reported", usage: result.shard!.usage } };
  return { result, artifact };
}
export function correspondenceRaw(prompt: string) {
  const request = JSON.parse(prompt) as SourceSemanticCorrespondenceRequest;
  const h = request.source_interpretation_descriptors[0]!.interpretation, q = request.admitted_query_semantics;
  const pairs: SourceSemanticCorrespondence["correspondences"][number][] = [];
  const referent = q.variables.find(v => v.reference?.excerpt === "Deployment Cedar")!;
  pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: referent.id },
    source_endpoint: { kind: "referent", referent: "rDeployment" }, query_support: referent.reference!,
    source_semantic_support: [{ kind: "lexical", mentions: [h.referents[0]!.mentions[0]!] }] });
  q.alternatives.forEach((alternative, index) => {
    for (const frame of alternative.frames) {
      const source = h.frames.find(f => f.predicate_support.kind === "explicit" && f.predicate_support.reading === frame.predicate_reading);
      if (source === undefined || source.predicate_support.kind !== "explicit") continue;
      pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: index, frame: frame.id },
        source_endpoint: { kind: "frame", frame: source.id }, query_support: { kind: "query_text", excerpt: frame.predicate_reading },
        source_semantic_support: [{ kind: "lexical", mentions: source.predicate_support.mentions }] });
      for (const slot of frame.role_requirements) pairs.push({ relation: "contextual_equivalence",
        query_endpoint: { kind: "slot", alternative: index, frame: frame.id, slot: slot.id },
        source_endpoint: { kind: "slot", frame: source.id, slot: "deployment" }, query_support: slot.support, source_semantic_support: [] });
    }
  });
  return correspondenceAssessmentJson({ ...request, producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
    producer_version: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION }, { correspondences: pairs });
}

export async function qualifiedSelectionFixture(directory: string) {
  // Freeze physical paths before deriving inputs or output roots under an aliased temp directory.
  directory = canonicalPath(directory);
  const task = alternativeSelectionFixture(selectionExecutionBudget), data = join(directory, "source"), root = join(directory, "experiment");
  const filename = join(data, "alaya.db"), snapshot = join(directory, "native.sqlite"), qCache = join(directory, "q-cache");
  const bodies = [...task.sources.map(row => ({ id: row.id, body: row.body })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `raw-${i}`, body: `Unqualified retained note ${i}.` }))];
  const daemon = await startBenchDaemon({ dataDirRoot: data, workspaceId: WS, runId: RUN,
    embeddingMode: "disabled", embeddingStartupProbe: "omit", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    for (const source of bodies) await daemon.importSourceRecord({ source_id: source.id, source_version: "1", content_bytes: source.body,
      event_time: null, recorded_at: CAPTURE, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, speaker: "user",
      valid_from: null, valid_to: null, scope_class: "project", spans: deriveAddressableSpanViews(source.body) });
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
  const database = initDatabase({ filename }), eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const publication = createSourceSemanticInterpretationPublication({ stores, sha256: fieldContractSha256,
    evidenceService: new EvidenceService({ eventLogRepo, runtimeNotifier,
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CAPTURE }) });
  const descriptors = new Map<string, SourceSemanticHandleDescriptor>();
  try {
    for (const source of task.sources) {
      const h = source.package.proofs[0]!.interpretation, locations = h.source.assertion_locations!;
      const catalog = buildSourceReferenceCatalog(fieldContractSha256(source.body), locations.map(row => ({ assertion_id: row.assertion_id,
        text: Buffer.from(source.body).subarray(...row.source_utf8_span).toString("utf8") })), fieldContractSha256);
      const published = await publication.publish({ workspaceId: WS, runId: RUN, artifactKey: source.id, source: source.body,
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, catalog, interpretation: h,
        assertion_locations: locations, provenance: { producer_id: "authored-selection" } });
      const actual = published.bound.interpretation;
      descriptors.set(source.id, { interpretation_id: published.bound.interpretation_id, source_id: source.id, source_version: "1",
        content_digest: published.source_record.content_digest, producer_id: actual.producer_id, producer_version: actual.producer_version,
        contract_version: actual.contract_version, interpretation: actual, source_disclosure: source.package.source_disclosure });
    }
  } finally { database.close(); closeCachedDatabase(filename); }
  const retained = join(directory, "retained.sqlite"); checkpointAndCopyBenchDb(filename, retained);
  const manifest = await admitRetainedNativeSourceSnapshot({ retainedPath: retained, expectedSha256: hashRegularFileNoFollow(retained),
    snapshotPath: snapshot, workspaceId: WS, runId: RUN, producerCommit: "0".repeat(40) });
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
    model: MODEL, request_profile: PROFILE, provider_url: URL, items: [{ original_query: task.original }] });
  const q = await authoredProposal(workset, qCache, () => interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    requested_operation: { reading: "establish", support: { kind: "query_text", excerpt: "establish" } },
    alternatives: task.alternatives.map(required => ({ conditions: [], evidence_inputs: required.map(input => ({ conditions: [{ kind: "statement",
      key: `input${input}`, predicate: deploymentStatement(input).slice("Deployment Cedar ".length, -1), arguments: [{ role: "deployment",
        target: { kind: "named", key: "deployment", excerpt: "Deployment Cedar" }, excerpt: "Deployment Cedar" }] }] })) })), gaps: [] }));
  if (q.result.received === undefined || !("query" in q.result.received)) throw new Error("authored query receipt missing");
  const semantics = q.result.received.query;
  const nominees = [];
  for (const selected of bodies.slice(0, 16)) {
    const member = manifest.sources.find(member => member.record.source_id === selected.id)!;
    const record = member.record, descriptor = descriptors.get(record.source_id);
    const tuple = { source_id: record.source_id, record_id: record.identity, source_version: record.source_version, content_digest: record.content_digest };
    let correspondence;
    if (descriptor !== undefined) {
      const cRoot = join(directory, `c-${record.source_id}`);
      const cWorkset = parseSemanticProposalWorkset({ ...workset, kind: "semantic_correspondence", items: [{ original_query: task.original,
        admitted_query_semantics: semantics, source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id,
          interpretation: descriptor.interpretation }] }] });
      const c = await authoredProposal(cWorkset, cRoot, correspondenceRaw);
      correspondence = { workset: cWorkset, cache_root: cRoot, max_output_tokens: TOKENS, artifact: c.artifact };
    }
    nominees.push({ nominee: tuple, current: tuple, body_bytes: Buffer.byteLength(bodies.find(source => source.id === record.source_id)!.body),
      ...(descriptor === undefined ? {} : { interpretation: descriptor }), ...(correspondence === undefined ? {} : { correspondence }) });
  }
  const input: SourceAcquisitionExperimentInput = { contract: "source-acquisition-experiment-v1", root, original_query: task.original,
    guard_allocation: { source_inputs: 0, utf8_bytes: 0 }, timeout_ms: 60000,
    host_admission: { total_work_units: 100, total_memory_bytes: 100, read_work_units: 1, read_memory_bytes: 1,
      max_input_bytes_per_read: 32 * 1024 * 1024, max_read_admissions: 16, max_effects: 1 },
    launch: await captureSourceAcquisitionLaunchBinding(),
    qualified_selection: { contract: "private-qualified-source-selection-v1", query_as_of: null,
      snapshot_identity: manifest.identity, snapshot_source_count: 17, query: q.artifact, nominees },
    config: { snapshot_path: snapshot, snapshot_sha256: manifest.db_sha256, implementation_revision: readCurrentExtractionAuthorityRevision(),
      interpretation_clock: CLOCK, workspace_id: WS, run_id: RUN, query_workset: workset, query_cache_root: qCache,
      correspondence_cache_root: join(directory, "unused-c-cache"), max_output_tokens: TOKENS, discovery_page_cap: 1,
      correspondence_pair_cap: 16, access_policy: "query-conditioned-v1", budget: { ...selectionExecutionBudget, work_units: 10_000_000, memory_bytes: 200_000_000 },
      authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 1_000_000 } };
  mkdirSync(root, { recursive: true });
  return { input, task, directory, root };
}
