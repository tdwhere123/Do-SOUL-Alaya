import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fieldContractSha256, type FieldFormationStores } from "@do-soul/alaya-core";
import type { SourceSemanticHostPreparation } from "@do-soul/alaya-soul";
import { AlayaError, HOST_SESSION_CONTRACT, IsoDatetimeStringSchema, canonicalJson,
  sourceSemanticInterpretationIdentity, type HostScopedReference,
  SourceRecordIdentitySchema, SourceSemanticInterpretationSchema } from "@do-soul/alaya-protocol";
import {
  closeCachedDatabase, initDatabase, openReadOnlyDatabase, sourceRecordFromRow,
  SqliteFieldSourceRecordRepo
} from "@do-soul/alaya-storage";
import { startBenchDaemon } from "../../../harness/daemon.js";
import type { ExtractionRequestProfile } from "../../extraction/request-profile.js";
import { hashRegularFileNoFollow } from "../bound-file.js";
import { currentBenchScope, trackBenchBody, trackBenchOperation, refuseBenchWorkAfterCancel } from "../../../harness/daemon-task.js";
import { checkpointAndCopyBenchDb, cloneCachedSealedSnapshot } from "../freeze/db-copy.js";
import { withSnapshotPublishLock } from "../freeze/publish-lock.js";
import { atomicWriteJson, BENCH_DAEMON_DB_FILENAME } from "../materialize.js";
import { censusCompleteSourceRecords, censusNativeSourceRecords, type SourceCensus, type SourceCensusRecord } from "./census.js";
import { readVerifiedNativeSourceSnapshot } from "./native.js";
import { longMemEvalSessionContainer } from "../../../datasets/longmemeval/ingestion/host-session-import.js";
import { resolveSourceRecordsImportEffects, type SourceRecordsImportEffects } from "./import-effects.js";
import { readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, sourceSemanticArtifactPreparations,
  type ExtractionOpenSemanticsGeneration } from "../../extraction/request-artifact.js";

type UnsupportedPreparation = Extract<SourceSemanticHostPreparation, { status: "unsupported_source" }>;
type HostPreparation = Readonly<{ status: "ready" }> | UnsupportedPreparation;
export type SourcePublicationAssociation =
  | Readonly<{ source_id: string; source_version: string; generation_key: string; request_digest: string }>
  | Readonly<{ source_id: string; source_version: string; content_digest: string; corpus_digest: string;
      provider_attempts: 0 }> & UnsupportedPreparation;

type SourcePublicationPopulationBase = Readonly<{
  name: string;
  cacheRoots?: readonly string[];
  model: string;
  requestProfile: ExtractionRequestProfile;
  publicationAssociations?: readonly SourcePublicationAssociation[];
  openSemantics?: ExtractionOpenSemanticsGeneration;
}>;
export type SourcePublicationPopulation = SourcePublicationPopulationBase & (
  Readonly<{ dataDir: string; pinnedMetaRoot: string; questionWindow?: Readonly<{ offset: number; limit: number }>;
    nativeSnapshotPath?: never }> |
  Readonly<{ nativeSnapshotPath: string; dataDir?: never; pinnedMetaRoot?: never; questionWindow?: never }>
);

export type SourcePublicationDisposition = Readonly<{
  source_id: string;
  source_version: string;
  content_digest: string;
  corpus_digest: string;
  population: string;
  question_id?: string;
  session_id?: string;
  session_index?: number;
  round_index?: number;
  native_record_id?: string;
  recorded_at?: string;
  title?: string;
  speaker: "user" | "assistant" | "system" | null;
  roles: readonly ("user" | "assistant")[];
  repeated_assertion_text: boolean;
  host_preparation: HostPreparation;
  provider_attempts?: 0;
  admission: "admitted" | "rejected";
  admission_reason?: string;
  record_id?: string;
  source_record?: import("@do-soul/alaya-protocol").SourceRecordIdentity;
  source_interpretation: "interpreted" | "abstained" | "no_executable_proposition" | "no_eligible_source" | "absent" | "invalid" | "conflict" | "copied_uninspected";
  source_interpretation_generation_key?: string;
  source_interpretation_binding?: Readonly<{ kind: "host_publication_association"; request_digest: string }>;
  publication: "published" | "not_attempted" | "failed";
  publication_error?: string;
  interpretation_id?: string;
  evidence_object_id?: string;
  correspondence_descriptor?: Readonly<{ source_interpretation_id: string;
    interpretation: import("@do-soul/alaya-protocol").SourceSemanticInterpretation }>;
}>;

export type SourcePublicationReport = Readonly<{
  schema_version: 3;
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
  source_interpretation_counts: Readonly<Record<SourcePublicationDisposition["source_interpretation"], number>>;
  host_preparation_counts: Readonly<{ ready: number; unsupported_source: number }>;
  sources: readonly SourcePublicationDisposition[];
  unbound_source_interpretation_artifacts: readonly UnboundSourceInterpretationArtifact[];
  source_interpretation_binding_complete: boolean;
}>;

const NativePublicationReportSchema = z.object({
  schema_version: z.literal(3), artifact_domain: z.literal("source_semantic_publication"),
  workspace_id: z.string(), run_id: z.string(), snapshot_path: z.string(), db_sha256: z.string(),
  census_count: z.number().int().nonnegative(), admitted_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
  sources: z.array(z.object({ source_id: z.string(), source_version: z.string(),
    content_digest: z.string(), corpus_digest: z.string(), record_id: z.string(),
    source_record: SourceRecordIdentitySchema,
    admission: z.enum(["admitted", "rejected"]), source_interpretation: z.string(),
    source_interpretation_generation_key: z.string().optional(),
    interpretation_id: z.string().optional(),
    correspondence_descriptor: z.object({ source_interpretation_id: z.string(),
      interpretation: SourceSemanticInterpretationSchema }).strict().optional()
  }).passthrough())
}).passthrough();

/** Read a sealed native publication against the complete original snapshot and current source identities. */
export function readNativeSourcePublicationReport(snapshotPathInput: string, originalSnapshotPath: string) {
  const snapshotPath = resolve(snapshotPathInput);
  const original = readVerifiedNativeSourceSnapshot(originalSnapshotPath);
  const report = NativePublicationReportSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: `${snapshotPath}.publication.json`, maxBytes: 32 * 1024 * 1024, label: "native source publication" })));
  if (report.snapshot_path !== snapshotPath || hashRegularFileNoFollow(snapshotPath) !== report.db_sha256 ||
      report.workspace_id !== original.manifest.workspace_id || report.run_id !== original.manifest.run_id ||
      report.census_count !== original.records.length || report.sources.length !== original.records.length ||
      report.admitted_count !== original.records.length || report.rejected_count !== 0) {
    throw new AlayaError("CONFLICT", "native source publication differs from sealed original population");
  }
  for (const [index, source] of original.records.entries()) {
    const published = report.sources[index];
    if (published?.admission !== "admitted" || published.source_id !== source.source_id ||
        published.source_version !== source.source_version || published.record_id !== source.record.identity ||
        published.content_digest !== source.record.content_digest ||
        published.corpus_digest !== fieldContractSha256(source.content_bytes) ||
        canonicalJson(published.source_record) !== canonicalJson(source.record) ||
        published.correspondence_descriptor !== undefined &&
          (published.source_interpretation !== "interpreted" ||
            published.correspondence_descriptor.source_interpretation_id !== published.interpretation_id ||
            sourceSemanticInterpretationIdentity(published.correspondence_descriptor.interpretation,
              fieldContractSha256) !== published.interpretation_id)) {
      throw new AlayaError("CONFLICT", "native source publication changed current membership or retained metadata");
    }
  }
  return report;
}

type UnboundSourceInterpretationArtifact = Readonly<{ population: string; generation_key: string; status: "invalid" | "unbound" }>;

/** Captures raw sources only. Historical passive artifacts cannot be republished through this owner. */
export async function publishSourceSemanticSnapshot(input: Readonly<{
  snapshotPath: string;
  dataDirRoot: string;
  populations: readonly SourcePublicationPopulation[];
  descriptorExportSourceIds?: readonly string[];
  recordedAt: string;
  producerCommit: string;
  workspaceId?: string;
  runId?: string;
  sourceLimits?: Readonly<{ maxSources: number; maxContentBytes: number }>;
  importEffects?: SourceRecordsImportEffects;
}>): Promise<SourcePublicationReport> {
  if (input.populations.some(population => (population.cacheRoots?.length ?? 0) > 0 ||
      (population.publicationAssociations?.length ?? 0) > 0) || (input.descriptorExportSourceIds?.length ?? 0) > 0) {
    throw new AlayaError("UNAVAILABLE", "passive source interpretation publication is retired; retained snapshots are read-only");
  }
  const importEffects = resolveSourceRecordsImportEffects(input.importEffects);
  const scope = currentBenchScope();
  const publishSnapshot = async (): Promise<SourcePublicationReport> => {
    refuseBenchWorkAfterCancel();
    const snapshotPath = resolve(input.snapshotPath);
    const dataDirRoot = resolve(input.dataDirRoot);
    if (snapshotPath === join(dataDirRoot, BENCH_DAEMON_DB_FILENAME)) throw new AlayaError("VALIDATION", "snapshot must differ from live DB");
    IsoDatetimeStringSchema.parse(input.recordedAt);
    if (!/^[a-f0-9]{40}$/u.test(input.producerCommit)) throw new AlayaError("VALIDATION", "producer commit must be a full SHA-1");
    const workspaceId = input.workspaceId ?? "source-semantic-library";
    const runId = input.runId ?? "source-semantic-library-run";
    const census = await loadCensus(input.populations);
    assertPublicationCensus(census, input.sourceLimits);
    refuseBenchWorkAfterCancel();
    const nativePopulation = input.populations.find(population => population.nativeSnapshotPath !== undefined);
    if (nativePopulation !== undefined && (input.populations.length !== 1 ||
        nativePopulation.nativeSnapshotPath === undefined)) {
      throw new AlayaError("VALIDATION", "native source publication requires one complete source population");
    }
    const preparations = prepareCensusSources(census, input.populations);
    return withSnapshotPublishLock(snapshotPath, () => withSnapshotPublishLock(join(dataDirRoot, "source-semantic-publication"), async () => {
      bindIsolatedSnapshot(dataDirRoot, snapshotPath);
      const dispositions = nativePopulation === undefined
        ? await admitCensusSources(dataDirRoot, snapshotPath, census, preparations, {
          recordedAt: input.recordedAt, workspaceId, runId, importEffects
        })
        : copyAdmittedNativeSources(nativePopulation.nativeSnapshotPath!, snapshotPath, census[0]!, preparations,
          workspaceId, runId);
      refuseBenchWorkAfterCancel();
      checkpointSnapshot(snapshotPath);
      const report = sealReport({
        recordedAt: input.recordedAt, workspaceId, runId, snapshotPath, census, dispositions, unbound: []
      });
      atomicWriteJson(`${snapshotPath}.publication.json`, report);
      return report;
    }));
  };
  return scope === undefined ? publishSnapshot() : trackBenchOperation(scope, publishSnapshot);
}

function assertPublicationCensus(census: readonly SourceCensus[], limits: Readonly<{ maxSources: number; maxContentBytes: number }> | undefined): void {
  let sources = 0, contentBytes = 0;
  for (const population of census) for (const source of population.records) {
    sources += 1; contentBytes += Buffer.byteLength(source.content_bytes, "utf8");
    // Only the host-session capture owner admits LongMemEval round roots.
    if (source.question_id !== undefined && (population.host_sessions === undefined || source.source_version !== HOST_SESSION_CONTRACT)) {
      throw new AlayaError("CONFLICT", "round source is not a host-session capture");
    }
  }
  if (limits !== undefined && (!Number.isSafeInteger(limits.maxSources) || limits.maxSources < 1 ||
      !Number.isSafeInteger(limits.maxContentBytes) || limits.maxContentBytes < 1 ||
      sources > limits.maxSources || contentBytes > limits.maxContentBytes)) {
    throw new AlayaError("VALIDATION", "source publication census exceeds its declared source/byte limits");
  }
}

function prepareCensusSources(census: readonly SourceCensus[], populations: readonly SourcePublicationPopulation[]) {
  const preparations = new Map<string, HostPreparation>();
  for (const population of census) {
    const config = populations.find(row => row.name === population.population)?.openSemantics;
    const generation = config ?? EXTRACTION_OPEN_SEMANTICS_GENERATION;
    for (const source of population.records) {
      const [prepared] = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", generation,
        source.attribution_context, source.source_role);
      if (prepared === undefined) throw new AlayaError("CONFLICT", "complete source publication has no host preparation");
      preparations.set(source.source_id, prepared.status === "ready" ? { status: "ready" } : prepared.disposition);
    }
  }
  return preparations;
}

async function loadCensus(populations: readonly SourcePublicationPopulation[]): Promise<readonly SourceCensus[]> {
  if (populations.length === 0) throw new AlayaError("VALIDATION", "source publication requires at least one population");
  const names = new Set<string>();
  const loaded: SourceCensus[] = [];
  for (const population of populations) {
    if (names.has(population.name)) throw new AlayaError("VALIDATION", `duplicate source population '${population.name}'`);
    names.add(population.name);
    if (population.nativeSnapshotPath !== undefined) {
      if (population.dataDir !== undefined || population.pinnedMetaRoot !== undefined || population.questionWindow !== undefined) {
        throw new AlayaError("VALIDATION", "native source population cannot carry LongMemEval input fields");
      }
      loaded.push(censusNativeSourceRecords({ population: population.name, snapshotPath: population.nativeSnapshotPath }));
    } else {
      if (population.dataDir === undefined || population.pinnedMetaRoot === undefined) {
        throw new AlayaError("VALIDATION", "LongMemEval source population requires pinned dataset paths");
      }
      loaded.push(await censusCompleteSourceRecords({
        population: population.name, dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
        ...(population.questionWindow === undefined ? {} : { questionWindow: population.questionWindow })
      }));
      refuseBenchWorkAfterCancel();
    }
  }
  return loaded;
}

function copyAdmittedNativeSources(sourceSnapshotPath: string, outputPath: string, census: SourceCensus,
  preparations: ReadonlyMap<string, HostPreparation>, workspaceId: string, runId: string): SourcePublicationDisposition[] {
  const native = readVerifiedNativeSourceSnapshot(sourceSnapshotPath);
  if (native.manifest.workspace_id !== workspaceId || native.manifest.run_id !== runId ||
      native.manifest.identity !== census.dataset_sha256 || native.records.length !== census.records.length) {
    throw new AlayaError("CONFLICT", "native publication source differs from verified complete census");
  }
  cloneCachedSealedSnapshot({
    sourcePath: resolve(sourceSnapshotPath),
    targetPath: outputPath,
    expectedSha256: native.manifest.db_sha256
  });
  return census.records.map((source, index) => {
    const record = native.records[index]?.record;
    if (record === undefined || record.identity !== source.native_record_id) {
      throw new AlayaError("CONFLICT", "native publication record differs from the sealed census");
    }
    const preparation = preparations.get(source.source_id)!;
    return { ...dispositionBase(source), host_preparation: preparation,
      ...(preparation.status === "unsupported_source" ? { provider_attempts: 0 as const } : {}),
      admission: "admitted" as const, record_id: record.identity, source_record: record,
      source_interpretation: "copied_uninspected" as const, publication: "not_attempted" as const };
  });
}

function bindIsolatedSnapshot(dataDirRoot: string, snapshotPath: string): void {
  if (existsSync(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME)) || existsSync(snapshotPath)) {
    throw new AlayaError("CONFLICT", "source semantic publication requires an isolated directory");
  }
  mkdirSync(dataDirRoot, { recursive: true });
}

async function admitCensusSources(
  dataDirRoot: string, snapshotPath: string, census: readonly SourceCensus[],
  preparations: ReadonlyMap<string, HostPreparation>,
  input: Readonly<{ recordedAt: string; workspaceId: string; runId: string; importEffects: SourceRecordsImportEffects | undefined }>
): Promise<SourcePublicationDisposition[]> {
  const daemon = await startBenchDaemon({
    ...input.importEffects, dataDirRoot, workspaceId: input.workspaceId, runId: input.runId,
    embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint", hostSessionReceiptTime: input.recordedAt
  });
  const failures = new Map<string, string>();
  try {
    const admit = async () => {
      refuseBenchWorkAfterCancel();
      for (const capture of census.flatMap(population => population.host_sessions ?? [])) {
        for (const request of capture.requests) {
          const container = containerLabel(request.container);
          // A failed window admitted nothing; later windows of that session would only leave a gap.
          if (failures.has(container)) continue;
          try {
            await daemon.captureHostSession(request, capture.issuer);
          } catch (error) {
            refuseBenchWorkAfterCancel();
            if (error instanceof AlayaError && error.code === "CANCELLED") throw error;
            failures.set(container, error instanceof Error ? error.message.slice(0, 300) : String(error));
          }
          refuseBenchWorkAfterCancel();
        }
      }
      await daemon.checkpointFieldProjection();
      refuseBenchWorkAfterCancel();
    };
    const scope = currentBenchScope();
    await (scope === undefined ? admit() : trackBenchBody(scope, admit));
  } finally {
    await daemon.shutdown();
  }
  refuseBenchWorkAfterCancel();
  checkpointAndCopyBenchDb(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME), snapshotPath);
  return capturedDispositions(snapshotPath, census, preparations, input.workspaceId, failures);
}

function containerLabel(container: HostScopedReference): string {
  return canonicalJson([container.scope, container.id]);
}

/** Each census round is the captured root of its session, or rejected with that session's capture failure. */
function capturedDispositions(snapshotPath: string, census: readonly SourceCensus[],
  preparations: ReadonlyMap<string, HostPreparation>, workspaceId: string,
  failures: ReadonlyMap<string, string>): SourcePublicationDisposition[] {
  const database = openReadOnlyDatabase(snapshotPath);
  try {
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    return census.flatMap(population => population.records.map((source): SourcePublicationDisposition => {
      const preparation = preparations.get(source.source_id)!;
      const base = { ...dispositionBase(source), host_preparation: preparation,
        ...(preparation.status === "unsupported_source" ? { provider_attempts: 0 as const } : {}),
        source_interpretation: "absent" as const, publication: "not_attempted" as const };
      const row = records.findCurrent(workspaceId, source.source_id);
      if (row === null) {
        return { ...base, admission: "rejected", admission_reason: failures.get(containerLabel(
          longMemEvalSessionContainer(source.question_id!, source.session_index!))) ?? "host session capture admitted no round root" };
      }
      const record = sourceRecordFromRow(row);
      if (record.source_version !== source.source_version || record.content_digest !== source.content_digest ||
          row.source_body !== source.content_bytes || record.event_time !== source.source_observed_at ||
          record.host_structure === undefined) {
        throw new AlayaError("CONFLICT", "captured round root differs from its census");
      }
      return { ...base, admission: "admitted", record_id: record.identity, source_record: record };
    }));
  } finally {
    database.close({ optimize: false });
  }
}

export function sourceLookupStores(database: ReturnType<typeof initDatabase>): Pick<FieldFormationStores, "getCurrentRecord" | "getStoredRecord"> {
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return {
    getCurrentRecord: (workspaceId, sourceId) => {
      const row = records.findCurrent(workspaceId, sourceId);
      return row === null ? null : sourceRecordFromRow(row);
    },
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
      throw new AlayaError("CONFLICT", "cannot freeze published snapshot: incomplete WAL checkpoint");
    }
  } finally {
    closeCachedDatabase(snapshotPath);
  }
}

function sealReport(input: Readonly<{
  recordedAt: string; workspaceId: string; runId: string; snapshotPath: string;
  census: readonly SourceCensus[]; dispositions: readonly SourcePublicationDisposition[];
  unbound: readonly UnboundSourceInterpretationArtifact[];
}>): SourcePublicationReport {
  const interpretationCounts = {
    interpreted: 0, abstained: 0, no_executable_proposition: 0, no_eligible_source: 0,
    absent: 0, invalid: 0, conflict: 0, copied_uninspected: 0
  };
  for (const row of input.dispositions) interpretationCounts[row.source_interpretation] += 1;
  return {
    schema_version: 3, artifact_domain: "source_semantic_publication",
    recorded_at: input.recordedAt, workspace_id: input.workspaceId, run_id: input.runId,
    snapshot_path: input.snapshotPath, db_sha256: hashRegularFileNoFollow(input.snapshotPath),
    census_count: input.dispositions.length,
    admitted_count: input.dispositions.filter((row) => row.admission === "admitted").length,
    rejected_count: input.dispositions.filter((row) => row.admission === "rejected").length,
    published_count: input.dispositions.filter((row) => row.publication === "published").length,
    source_interpretation_counts: interpretationCounts, sources: input.dispositions,
    host_preparation_counts: {
      ready: input.dispositions.filter((row) => row.host_preparation.status === "ready").length,
      unsupported_source: input.dispositions.filter((row) => row.host_preparation.status === "unsupported_source").length
    },
    unbound_source_interpretation_artifacts: input.unbound, source_interpretation_binding_complete: input.unbound.length === 0 &&
      input.dispositions.every((row) => row.source_interpretation !== "invalid" && row.source_interpretation !== "conflict" &&
        row.source_interpretation !== "copied_uninspected")
  };
}

function dispositionBase(source: SourceCensusRecord): Omit<SourcePublicationDisposition,
  "admission" | "source_interpretation" | "publication" | "host_preparation"> {
  return {
    source_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest,
    corpus_digest: source.corpus_digest, population: source.population,
    ...(source.question_id === undefined ? {} : { question_id: source.question_id }),
    ...(source.session_id === undefined ? {} : { session_id: source.session_id }),
    ...(source.session_index === undefined ? {} : { session_index: source.session_index }),
    ...(source.round_index === undefined ? {} : { round_index: source.round_index }),
    ...(source.native_record_id === undefined ? {} : { native_record_id: source.native_record_id }),
    ...(source.recorded_at === undefined ? {} : { recorded_at: source.recorded_at }),
    ...(source.title === undefined ? {} : { title: source.title }),
    speaker: source.speaker ?? null, roles: source.roles, repeated_assertion_text: source.repeated_assertion_text
  };
}
