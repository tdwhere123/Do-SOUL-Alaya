import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createSourceSemanticInterpretationPublication, deriveAddressableSpanViews, EvidenceService,
  fieldContractSha256, type FieldFormationStores
} from "@do-soul/alaya-core";
import { IsoDatetimeStringSchema, SOURCE_SEMANTIC_PACKET_CONTRACT } from "@do-soul/alaya-protocol";
import {
  closeCachedDatabase, initDatabase, sourceRecordFromRow, SqliteEvidenceCapsuleRepo, SqliteEventLogRepo,
  SqliteFieldSourceRecordRepo
} from "@do-soul/alaya-storage";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { inspectCachedSourceSemantic } from "../../extraction/cache/source-semantic-artifact.js";
import { publishAdmittedSourceSemanticInterpretation } from "../../extraction/cache/source-semantic-runtime-publish.js";
import type { ExtractionRequestProfile } from "../../extraction/request-profile.js";
import { hashRegularFileNoFollow } from "../bound-file.js";
import { checkpointAndCopyBenchDb } from "../freeze/db-copy.js";
import { withSnapshotPublishLock } from "../freeze/publish-lock.js";
import { atomicWriteJson, BENCH_DAEMON_DB_FILENAME } from "../materialize.js";
import { censusCompleteSourceRecords, type SourceCensus, type SourceCensusRecord } from "./census.js";

export type SourcePublicationPopulation = Readonly<{
  name: string;
  dataDir: string;
  pinnedMetaRoot: string;
  cacheRoot?: string;
  model: string;
  requestProfile: ExtractionRequestProfile;
}>;

export type SourcePublicationDisposition = Readonly<{
  source_id: string;
  source_version: string;
  content_digest: string;
  corpus_digest: string;
  population: string;
  question_id: string;
  speaker: "user" | "assistant" | "system" | null;
  roles: readonly ("user" | "assistant")[];
  repeated_assertion_text: boolean;
  admission: "admitted" | "rejected";
  admission_reason?: string;
  record_id?: string;
  h: "interpreted" | "abstained" | "no_executable_proposition" | "no_eligible_source" | "absent" | "invalid" | "conflict";
  h_generation_key?: string;
  publication: "published" | "not_attempted" | "failed";
  publication_error?: string;
  interpretation_id?: string;
  evidence_object_id?: string;
}>;

export type SourcePublicationReport = Readonly<{
  schema_version: 1;
  artifact_domain: "source_semantic_publication";
  recorded_at: string;
  workspace_id: string;
  run_id: string;
  snapshot_path: string;
  db_sha256: string;
  census_count: number;
  admitted_count: number;
  rejected_count: number;
  published_count: number;
  h_counts: Readonly<Record<SourcePublicationDisposition["h"], number>>;
  sources: readonly SourcePublicationDisposition[];
}>;

export async function publishSourceSemanticSnapshot(input: Readonly<{
  snapshotPath: string;
  dataDirRoot: string;
  populations: readonly SourcePublicationPopulation[];
  recordedAt: string;
  producerCommit: string;
  workspaceId?: string;
  runId?: string;
}>): Promise<SourcePublicationReport> {
  const snapshotPath = resolve(input.snapshotPath);
  const dataDirRoot = resolve(input.dataDirRoot);
  if (snapshotPath === join(dataDirRoot, BENCH_DAEMON_DB_FILENAME)) throw new Error("snapshot must differ from live DB");
  IsoDatetimeStringSchema.parse(input.recordedAt);
  if (!/^[a-f0-9]{40}$/u.test(input.producerCommit)) throw new Error("producer commit must be a full SHA-1");
  const workspaceId = input.workspaceId ?? "source-semantic-library";
  const runId = input.runId ?? "source-semantic-library-run";
  const census = await loadCensus(input.populations);
  return withSnapshotPublishLock(snapshotPath, () => withSnapshotPublishLock(join(dataDirRoot, "source-semantic-publication"), async () => {
    bindIsolatedSnapshot(dataDirRoot, snapshotPath);
    const dispositions = await admitCensusSources(dataDirRoot, snapshotPath, census, {
      recordedAt: input.recordedAt, workspaceId, runId
    });
    await publishRetainedSemantics(snapshotPath, census, input.populations, dispositions, workspaceId, runId);
    checkpointSnapshot(snapshotPath);
    const report = sealReport({
      recordedAt: input.recordedAt, workspaceId, runId, snapshotPath, census, dispositions
    });
    atomicWriteJson(`${snapshotPath}.publication.json`, report);
    return report;
  }));
}

async function loadCensus(populations: readonly SourcePublicationPopulation[]): Promise<readonly SourceCensus[]> {
  if (populations.length === 0) throw new Error("source publication requires at least one population");
  const names = new Set<string>();
  const loaded: SourceCensus[] = [];
  for (const population of populations) {
    if (names.has(population.name)) throw new Error(`duplicate source population '${population.name}'`);
    names.add(population.name);
    loaded.push(await censusCompleteSourceRecords({
      population: population.name, dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot
    }));
  }
  return loaded;
}

function bindIsolatedSnapshot(dataDirRoot: string, snapshotPath: string): void {
  if (existsSync(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME)) || existsSync(snapshotPath)) {
    throw new Error("source semantic publication requires an isolated directory");
  }
  mkdirSync(dataDirRoot, { recursive: true });
}

async function admitCensusSources(
  dataDirRoot: string, snapshotPath: string, census: readonly SourceCensus[],
  input: Readonly<{ recordedAt: string; workspaceId: string; runId: string }>
): Promise<SourcePublicationDisposition[]> {
  const daemon = await startBenchDaemon({
    dataDirRoot, workspaceId: input.workspaceId, runId: input.runId,
    embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint"
  });
  const dispositions: SourcePublicationDisposition[] = [];
  try {
    for (const population of census) {
      for (const source of population.records) {
        dispositions.push(await admitOneSource(daemon, source, input.recordedAt));
      }
    }
    await daemon.checkpointFieldProjection();
  } finally {
    await daemon.shutdown();
  }
  checkpointAndCopyBenchDb(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME), snapshotPath);
  return dispositions;
}

async function admitOneSource(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  source: SourceCensusRecord, recordedAt: string
): Promise<SourcePublicationDisposition> {
  const base = dispositionBase(source);
  try {
    const admitted = await daemon.importSourceRecord({
      source_id: source.source_id, source_version: source.source_version, content_bytes: source.content_bytes,
      recorded_at: recordedAt, event_time: source.source_observed_at, valid_from: null, valid_to: null,
      scope_class: "project", spans: deriveAddressableSpanViews(source.content_bytes),
      ...(source.speaker === undefined ? {} : { speaker: source.speaker })
    });
    return { ...base, admission: "admitted", record_id: admitted.record.identity, h: "absent", publication: "not_attempted" };
  } catch (error) {
    return {
      ...base, admission: "rejected",
      admission_reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
      h: "absent", publication: "not_attempted"
    };
  }
}

async function publishRetainedSemantics(
  snapshotPath: string, census: readonly SourceCensus[],
  populations: readonly SourcePublicationPopulation[],
  dispositions: SourcePublicationDisposition[],
  workspaceId: string, runId: string
): Promise<void> {
  const joined = indexRetainedSemantics(census, populations);
  const database = initDatabase({ filename: snapshotPath });
  try {
    const publication = createSourceSemanticInterpretationPublication({
      stores: sourceLookupStores(database),
      evidenceService: new EvidenceService({
        eventLogRepo: new SqliteEventLogRepo(database),
        evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
        runtimeNotifier: { notifyEntry: async () => undefined }
      }),
      sha256: fieldContractSha256
    });
    for (const [index, source] of census.flatMap((row) => row.records).entries()) {
      const current = dispositions[index]!;
      if (current.admission !== "admitted") continue;
      dispositions[index] = await publishOneSource(
        publication, joined.get(source.corpus_digest), source, current, workspaceId, runId
      );
    }
  } finally {
    closeCachedDatabase(snapshotPath);
  }
}

async function publishOneSource(
  publication: ReturnType<typeof createSourceSemanticInterpretationPublication>,
  retained: RetainedSemantics | undefined,
  source: SourceCensusRecord,
  current: SourcePublicationDisposition,
  workspaceId: string, runId: string
): Promise<SourcePublicationDisposition> {
  if (retained === undefined) return current;
  if (retained.status !== "hit") {
    return { ...current, h: retained.status, ...(retained.key === undefined ? {} : { h_generation_key: retained.key }) };
  }
  const native = retained.native;
  const h = classifyRetainedH(native.admitted.outcome.status);
  const generation = { h, ...(retained.key === undefined ? {} : { h_generation_key: retained.key }) };
  if (h !== "interpreted") return { ...current, ...generation };
  const request = native.admitted.request;
  const locations = request.source_request.assertion_locations;
  const interpretation = native.admitted.interpretation;
  const draft = native.admitted.draft;
  if (interpretation === undefined && draft === undefined) {
    return { ...current, ...generation, publication: "failed", publication_error: "interpreted H has no draft or normalized interpretation" };
  }
  try {
    const published = await publishAdmittedSourceSemanticInterpretation({
      publication, workspaceId, runId, artifactKey: source.source_id, source: source.content_bytes,
      catalog: request.source_catalog, producer_id: request.source_request.producer_capability.producer_id,
      producer_version: request.source_request.producer_capability.producer_version,
      contract_version: SOURCE_SEMANTIC_PACKET_CONTRACT,
      ...(interpretation === undefined ? { draft } : { interpretation }),
      ...(locations === undefined ? {} : { assertion_locations: locations })
    });
    return {
      ...current, ...generation, publication: "published",
      interpretation_id: published.bound.interpretation_id, evidence_object_id: published.evidence.object_id
    };
  } catch (error) {
    return {
      ...current, ...generation, publication: "failed",
      publication_error: error instanceof Error ? error.message.slice(0, 300) : String(error)
    };
  }
}

type Inspected = Extract<ReturnType<typeof inspectCachedSourceSemantic>, { status: "hit" }>;
type RetainedSemantics =
  | Readonly<{ status: "invalid" | "conflict"; key?: string }>
  | Readonly<{ status: "hit"; key: string; native: Inspected }>;

function indexRetainedSemantics(
  census: readonly SourceCensus[], populations: readonly SourcePublicationPopulation[]
): Map<string, RetainedSemantics> {
  const allowed = new Set(census.flatMap((row) => row.records.map((source) => source.corpus_digest)));
  const joined = new Map<string, RetainedSemantics>();
  for (const population of populations) {
    if (population.cacheRoot === undefined) continue;
    for (const key of listShardKeys(population.cacheRoot)) {
      const native = inspectCachedSourceSemantic(population.cacheRoot, key, population.model, population.requestProfile);
      if (native.status !== "hit") continue;
      const digest = native.admitted.request.source_catalog.source_digest;
      if (!allowed.has(digest)) continue;
      const existing = joined.get(digest);
      if (existing !== undefined && (existing.status !== "hit" || existing.key !== key)) {
        joined.set(digest, { status: "conflict", key });
        continue;
      }
      joined.set(digest, { status: "hit", key, native });
    }
  }
  return joined;
}

function listShardKeys(cacheRoot: string): readonly string[] {
  const keys: string[] = [];
  if (!existsSync(cacheRoot)) return keys;
  for (const bucket of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/u.test(bucket.name)) continue;
    for (const file of readdirSync(join(cacheRoot, bucket.name))) {
      if (/^[0-9a-f]{64}\.json$/u.test(file)) keys.push(file.slice(0, 64));
    }
  }
  return keys.sort();
}

function sourceLookupStores(database: ReturnType<typeof initDatabase>): Pick<FieldFormationStores, "listRecords" | "getStoredRecord"> {
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return {
    listRecords: (workspaceId) => records.listByWorkspace(workspaceId).map(sourceRecordFromRow),
    getStoredRecord: (workspaceId, recordId) => {
      const row = records.findById(workspaceId, recordId);
      return row?.source_body == null ? null : { record: sourceRecordFromRow(row), content_bytes: row.source_body };
    }
  };
}

function checkpointSnapshot(snapshotPath: string): void {
  const database = initDatabase({ filename: snapshotPath });
  try {
    const [checkpoint] = database.connection.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      readonly busy: number; readonly log: number; readonly checkpointed: number;
    }>;
    if (checkpoint === undefined || checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
      throw new Error("cannot freeze published snapshot: incomplete WAL checkpoint");
    }
  } finally {
    closeCachedDatabase(snapshotPath);
  }
}

function sealReport(input: Readonly<{
  recordedAt: string; workspaceId: string; runId: string; snapshotPath: string;
  census: readonly SourceCensus[]; dispositions: readonly SourcePublicationDisposition[];
}>): SourcePublicationReport {
  const hCounts = {
    interpreted: 0, abstained: 0, no_executable_proposition: 0, no_eligible_source: 0,
    absent: 0, invalid: 0, conflict: 0
  };
  for (const row of input.dispositions) hCounts[row.h] += 1;
  return {
    schema_version: 1, artifact_domain: "source_semantic_publication",
    recorded_at: input.recordedAt, workspace_id: input.workspaceId, run_id: input.runId,
    snapshot_path: input.snapshotPath, db_sha256: hashRegularFileNoFollow(input.snapshotPath),
    census_count: input.dispositions.length,
    admitted_count: input.dispositions.filter((row) => row.admission === "admitted").length,
    rejected_count: input.dispositions.filter((row) => row.admission === "rejected").length,
    published_count: input.dispositions.filter((row) => row.publication === "published").length,
    h_counts: hCounts, sources: input.dispositions
  };
}

function classifyRetainedH(status: string): SourcePublicationDisposition["h"] {
  if (status === "interpreted" || status === "abstained" || status === "no_executable_proposition" || status === "no_eligible_source") {
    return status;
  }
  return "invalid";
}

function dispositionBase(source: SourceCensusRecord): Omit<SourcePublicationDisposition, "admission" | "h" | "publication"> {
  return {
    source_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest,
    corpus_digest: source.corpus_digest, population: source.population, question_id: source.question_id,
    speaker: source.speaker ?? null, roles: source.roles, repeated_assertion_text: source.repeated_assertion_text
  };
}

