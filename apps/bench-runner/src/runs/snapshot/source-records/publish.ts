import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  createSourceSemanticInterpretationPublication, deriveAddressableSpanViews, EvidenceService,
  fieldContractSha256, type FieldFormationStores
} from "@do-soul/alaya-core";
import { prepareSourceSemanticRequest, sourceSemanticRequestCatalog, SourceSemanticUnsupportedSourceSchema,
  type SourceSemanticHostPreparation } from "@do-soul/alaya-soul";
import { AlayaError, IsoDatetimeStringSchema, SOURCE_SEMANTIC_PACKET_CONTRACT, canonicalJson } from "@do-soul/alaya-protocol";
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
import { SOURCE_SEMANTIC_BATCH_PRODUCER_ID, SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION } from "../../extraction/request-artifact.js";

type UnsupportedPreparation = Extract<SourceSemanticHostPreparation, { status: "unsupported_source" }>;
type HostPreparation = Readonly<{ status: "ready" }> | UnsupportedPreparation;
export type SourcePublicationAssociation =
  | Readonly<{ source_id: string; source_version: string; generation_key: string; request_digest: string }>
  | Readonly<{ source_id: string; source_version: string; content_digest: string; corpus_digest: string;
      provider_attempts: 0 }> & UnsupportedPreparation;

const ReadyAssociationSchema = z.object({ source_id: z.string().min(1), source_version: z.string().min(1),
  generation_key: z.string().regex(/^[a-f0-9]{64}$/u), request_digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const UnsupportedOccurrenceSchema = z.object({ source_id: z.string().min(1), source_version: z.string().min(1),
  content_digest: z.string().min(1), corpus_digest: z.string().min(1), provider_attempts: z.literal(0) }).passthrough();

/** One row contract for source publication inputs and native LongMemEval config. */
export const SourcePublicationAssociationRowSchema = z.unknown().transform((row, context): SourcePublicationAssociation => {
  try {
    return parseSourcePublicationAssociationRow(row);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid source association" });
    return z.NEVER;
  }
});

function parseSourcePublicationAssociationRow(row: unknown): SourcePublicationAssociation {
  if (typeof row !== "object" || row === null || !("status" in row)) return ReadyAssociationSchema.parse(row);
  const parsed = UnsupportedOccurrenceSchema.parse(row);
  const { source_id, source_version, content_digest, corpus_digest, provider_attempts, ...host } = parsed;
  const disposition = SourceSemanticUnsupportedSourceSchema.parse(host);
  return { source_id, source_version, content_digest, corpus_digest, ...disposition, provider_attempts };
}

export function parseSourcePublicationAssociations(value: unknown): readonly SourcePublicationAssociation[] {
  return z.object({ contract: z.literal("source-publication-associations-v2"),
    publicationAssociations: z.array(SourcePublicationAssociationRowSchema).max(10000) }).strict().parse(value).publicationAssociations;
}

export type SourcePublicationPopulation = Readonly<{
  name: string;
  dataDir: string;
  pinnedMetaRoot: string;
  questionWindow?: Readonly<{ offset: number; limit: number }>;
  cacheRoots?: readonly string[];
  model: string;
  requestProfile: ExtractionRequestProfile;
  publicationAssociations?: readonly SourcePublicationAssociation[];
}>;

export type SourcePublicationDisposition = Readonly<{
  source_id: string;
  source_version: string;
  content_digest: string;
  corpus_digest: string;
  population: string;
  question_id: string;
  session_id: string;
  session_index: number;
  round_index: number;
  speaker: "user" | "assistant" | "system" | null;
  roles: readonly ("user" | "assistant")[];
  repeated_assertion_text: boolean;
  host_preparation: HostPreparation;
  provider_attempts?: 0;
  admission: "admitted" | "rejected";
  admission_reason?: string;
  record_id?: string;
  source_record?: import("@do-soul/alaya-protocol").SourceRecordIdentity;
  source_interpretation: "interpreted" | "abstained" | "no_executable_proposition" | "no_eligible_source" | "absent" | "invalid" | "conflict";
  source_interpretation_generation_key?: string;
  source_interpretation_binding?: Readonly<{ kind: "host_publication_association"; request_digest: string }>;
  publication: "published" | "not_attempted" | "failed";
  publication_error?: string;
  interpretation_id?: string;
  evidence_object_id?: string;
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

type UnboundSourceInterpretationArtifact = Readonly<{ population: string; generation_key: string; status: "invalid" | "unbound" }>;

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
  if (snapshotPath === join(dataDirRoot, BENCH_DAEMON_DB_FILENAME)) throw new AlayaError("VALIDATION", "snapshot must differ from live DB");
  IsoDatetimeStringSchema.parse(input.recordedAt);
  if (!/^[a-f0-9]{40}$/u.test(input.producerCommit)) throw new AlayaError("VALIDATION", "producer commit must be a full SHA-1");
  const workspaceId = input.workspaceId ?? "source-semantic-library";
  const runId = input.runId ?? "source-semantic-library-run";
  const census = await loadCensus(input.populations);
  const preparations = prepareCensusSources(census);
  // Validate and inspect associations before creating any database or source record.
  const retained = indexRetainedSemantics(census, input.populations, preparations);
  return withSnapshotPublishLock(snapshotPath, () => withSnapshotPublishLock(join(dataDirRoot, "source-semantic-publication"), async () => {
    bindIsolatedSnapshot(dataDirRoot, snapshotPath);
    const dispositions = await admitCensusSources(dataDirRoot, snapshotPath, census, preparations, {
      recordedAt: input.recordedAt, workspaceId, runId
    });
    await publishRetainedSemantics(snapshotPath, census, retained.joined, dispositions, workspaceId, runId);
    checkpointSnapshot(snapshotPath);
    const report = sealReport({
      recordedAt: input.recordedAt, workspaceId, runId, snapshotPath, census, dispositions, unbound: retained.unbound
    });
    atomicWriteJson(`${snapshotPath}.publication.json`, report);
    return report;
  }));
}

function prepareCensusSources(census: readonly SourceCensus[]): ReadonlyMap<string, HostPreparation> {
  const preparations = new Map<string, HostPreparation>();
  for (const source of census.flatMap((population) => population.records)) {
    const result = prepareSourceSemanticRequest({ sourceCorpus: source.content_bytes,
      assertionIds: source.units.map((unit) => unit.assertion_id), sourceScope: "complete-source",
      source_id: source.source_id, source_version: source.source_version,
      producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID, producer_version: SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION });
    preparations.set(source.source_id, result.status === "ready" ? { status: "ready" } : result);
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
    loaded.push(await censusCompleteSourceRecords({
      population: population.name, dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
      ...(population.questionWindow === undefined ? {} : { questionWindow: population.questionWindow })
    }));
  }
  return loaded;
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
        dispositions.push(await admitOneSource(daemon, source, preparations.get(source.source_id)!, input.recordedAt));
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
  source: SourceCensusRecord, preparation: HostPreparation, recordedAt: string
): Promise<SourcePublicationDisposition> {
  const base = { ...dispositionBase(source), host_preparation: preparation,
    ...(preparation.status === "unsupported_source" ? { provider_attempts: 0 as const } : {}) };
  try {
    const admitted = await daemon.importSourceRecord({
      source_id: source.source_id, source_version: source.source_version, content_bytes: source.content_bytes,
      recorded_at: recordedAt, event_time: source.source_observed_at, valid_from: null, valid_to: null,
      scope_class: "project", spans: deriveAddressableSpanViews(source.content_bytes),
      ...(source.speaker === undefined ? {} : { speaker: source.speaker })
    });
    return { ...base, admission: "admitted", record_id: admitted.record.identity, source_record: admitted.record, source_interpretation: "absent", publication: "not_attempted" };
  } catch (error) {
    return {
      ...base, admission: "rejected",
      admission_reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
      source_interpretation: "absent", publication: "not_attempted"
    };
  }
}

async function publishRetainedSemantics(
  snapshotPath: string, census: readonly SourceCensus[],
  joined: ReadonlyMap<string, RetainedSemantics>,
  dispositions: SourcePublicationDisposition[],
  workspaceId: string, runId: string
): Promise<void> {
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
      if (current.admission !== "admitted" || current.host_preparation.status === "unsupported_source") continue;
      dispositions[index] = await publishOneSource(
        publication, joined.get(source.source_id), source, current, workspaceId, runId
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
    return { ...current, source_interpretation: retained.status, ...(retained.key === undefined ? {} : { source_interpretation_generation_key: retained.key }) };
  }
  const native = retained.native;
  const source_interpretation = classifyRetainedInterpretation(native.admitted.outcome.status);
  const generation = { source_interpretation, source_interpretation_generation_key: retained.key,
    source_interpretation_binding: { kind: "host_publication_association" as const, request_digest: native.requestDigest } };
  if (source_interpretation !== "interpreted") return { ...current, ...generation };
  const request = native.admitted.request;
  const locations = request.source_request.assertion_locations;
  const interpretation = native.admitted.interpretation;
  const draft = native.admitted.draft;
  if (interpretation === undefined && draft === undefined) {
    return { ...current, ...generation, publication: "failed", publication_error: "interpreted source interpretation has no draft or normalized interpretation" };
  }
  try {
    const published = await publishAdmittedSourceSemanticInterpretation({
      publication, workspaceId, runId, artifactKey: source.source_id, source: source.content_bytes,
      catalog: sourceSemanticRequestCatalog(request), producer_id: request.source_request.producer_capability.producer_id,
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
  census: readonly SourceCensus[], populations: readonly SourcePublicationPopulation[],
  preparations: ReadonlyMap<string, HostPreparation>
): { joined: Map<string, RetainedSemantics>; unbound: UnboundSourceInterpretationArtifact[] } {
  const joined = new Map<string, RetainedSemantics>();
  const unbound: UnboundSourceInterpretationArtifact[] = [];
  for (const population of populations) {
    const sources = new Map(census.find((row) => row.population === population.name)!.records.map((source) => [source.source_id, source]));
    const bindings = population.publicationAssociations ?? [];
    const cacheRoots = population.cacheRoots ?? [];
    if (new Set(cacheRoots.map((root) => resolve(root))).size !== cacheRoots.length) {
      throw new AlayaError("VALIDATION", "retained source interpretation cache roots repeat a generation directory");
    }
    if (bindings.some((binding) => "generation_key" in binding) && cacheRoots.length === 0) {
      throw new AlayaError("CONFLICT", "retained source interpretation association requires a cache root");
    }
    const boundSources = new Set<string>();
    for (const binding of bindings) {
      const source = sources.get(binding.source_id);
      if (source === undefined || source.source_version !== binding.source_version) {
        throw new AlayaError("CONFLICT", "retained source-interpretation binding does not match the frozen source census");
      }
      if (boundSources.has(binding.source_id)) throw new AlayaError("CONFLICT", "retained source interpretation association repeats a source");
      boundSources.add(binding.source_id);
      const preparation = preparations.get(binding.source_id)!;
      if ("generation_key" in binding) {
        if (preparation.status !== "ready" || !/^[a-f0-9]{64}$/u.test(binding.generation_key) ||
            !/^[a-f0-9]{64}$/u.test(binding.request_digest)) {
          throw new AlayaError("CONFLICT", "retained source-interpretation binding has no legal ready request");
        }
      } else if (preparation.status !== "unsupported_source" || canonicalJson(binding) !== canonicalJson({
        source_id: source.source_id, source_version: source.source_version,
        content_digest: source.content_digest, corpus_digest: source.corpus_digest,
        ...preparation, provider_attempts: 0
      })) {
        throw new AlayaError("CONFLICT", "retained unsupported source disposition differs from current census or contract");
      }
    }
    const seenKeys = new Set<string>();
    for (const cacheRoot of cacheRoots) {
      for (const key of listRetainedSourceSemanticKeys(cacheRoot)) {
        if (seenKeys.has(key)) throw new AlayaError("CONFLICT", "retained source interpretation generation key occurs in multiple cache roots");
        seenKeys.add(key);
        const native = inspectCachedSourceSemantic(cacheRoot, key, population.model, population.requestProfile);
        const matched = bindings.filter((binding): binding is Extract<SourcePublicationAssociation, { generation_key: string }> =>
          "generation_key" in binding && binding.generation_key === key);
        if (matched.length === 0) {
          unbound.push({ population: population.name, generation_key: key, status: native.status === "hit" ? "unbound" : "invalid" });
        }
        for (const binding of matched) {
          const source = sources.get(binding.source_id)!;
          const valid = native.status === "hit" &&
            sourceSemanticRequestCatalog(native.admitted.request).source_digest === source.corpus_digest &&
            native.requestDigest === binding.request_digest;
          const existing = joined.get(source.source_id);
          if (existing !== undefined && (existing.status !== "hit" || existing.key !== key)) {
            joined.set(source.source_id, { status: "conflict", key });
          } else {
            joined.set(source.source_id, valid && native.status === "hit" ? { status: "hit", key, native } : { status: "invalid", key });
          }
        }
      }
    }
    for (const binding of bindings) {
      if (!("generation_key" in binding)) continue;
      if (!joined.has(binding.source_id)) joined.set(binding.source_id, { status: "invalid", key: binding.generation_key });
    }
  }
  return { joined, unbound };
}

export function listRetainedSourceSemanticKeys(cacheRoot: string): readonly string[] {
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
    absent: 0, invalid: 0, conflict: 0
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
      input.dispositions.every((row) => row.source_interpretation !== "invalid" && row.source_interpretation !== "conflict")
  };
}

function classifyRetainedInterpretation(status: string): SourcePublicationDisposition["source_interpretation"] {
  if (status === "interpreted" || status === "abstained" || status === "no_executable_proposition" || status === "no_eligible_source") {
    return status;
  }
  return "invalid";
}

function dispositionBase(source: SourceCensusRecord): Omit<SourcePublicationDisposition,
  "admission" | "source_interpretation" | "publication" | "host_preparation"> {
  return {
    source_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest,
    corpus_digest: source.corpus_digest, population: source.population, question_id: source.question_id,
    session_id: source.session_id, session_index: source.session_index, round_index: source.round_index,
    speaker: source.speaker ?? null, roles: source.roles, repeated_assertion_text: source.repeated_assertion_text
  };
}
