import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { AlayaError, IsoDatetimeStringSchema } from "@do-soul/alaya-protocol";
import { deriveAddressableSpanViews } from "@do-soul/alaya-core";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { resolveBenchDaemonConfigRoot } from "../../../harness/daemon/daemon-config-directory.js";
import { preparePersonaSuccessor, personaPredecessor, type PersonaSuccessorInput,
  type PreparedPersonaSuccessor } from "./persona-successor.js";
import { LongMemEvalPersonaSuccessorSchema, type LongMemEvalPersonaSuccessor } from
  "../../../datasets/longmemeval/ingestion/task-persona.js";
import { loadDatasetWindowWithIdentity } from "../../../datasets/longmemeval/ingestion/fetch.js";
import { buildLongMemEvalRoundMessages, pairSessionIntoRounds, type LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { assertLongMemEvalTimeline, requireLongMemEvalTimestamp } from "../../../datasets/longmemeval/ingestion/source-time.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../selection/question-runtime-identity.js";
import { atomicWriteJson, BENCH_DAEMON_DB_FILENAME } from "../materialize.js";
import { checkpointAndCopyBenchDb } from "../freeze/db-copy.js";
import { withSnapshotPublishLock } from "../freeze/publish-lock.js";
import { hashRegularFileNoFollow, readRegularFileNoFollow } from "../bound-file.js";
import { SourceRecordsDatasetSchema, SourceRecordsManifestSchema, createSourceRecordsSidecarWriter, inspectSourceRecordsArtifact,
  sealSourceRecordsManifest, sourceRecordsManifestPath, sourceRecordsSidecarPath,
  type SourceRecordsDataset, type SourceRecordsSidecar, type SourceRecordsManifest } from "./contract.js";

export type PrepareSourceRecordsInput = Readonly<{
  snapshotPath: string; dataDirRoot: string; dataDir?: string; pinnedMetaRoot?: string;
  offset: number; limit: number; recordedAt: string; producerCommit: string;
  personaSuccessor?: PersonaSuccessorInput;
  /** Private execution effects, not retained source identity or reasoning/model setup. */
  importEffects?: SourceRecordsImportEffects;
}>;
const ImportEffectsSchema = z.object({
  configDirectoryRoot: z.string().min(1), sqliteWriteQueue: z.literal("disabled"),
  embeddingStartupProbe: z.literal("omit"), gardenCompute: z.literal("disabled")
}).strict();
export type SourceRecordsImportEffects = Readonly<z.infer<typeof ImportEffectsSchema>>;
const PreparationSchema = z.object({
  artifact_domain: z.literal("source_records"), dataset: SourceRecordsDatasetSchema,
  recorded_at: IsoDatetimeStringSchema, snapshot_path: z.string().min(1),
  persona_successor: LongMemEvalPersonaSuccessorSchema.optional()
}).strict();

export async function prepareSourceRecordsSnapshot(input: PrepareSourceRecordsInput): Promise<SourceRecordsManifest> {
  const parsedEffects = input.importEffects === undefined ? undefined : ImportEffectsSchema.parse(input.importEffects);
  const importEffects = parsedEffects === undefined ? undefined : { ...parsedEffects,
    configDirectoryRoot: resolveBenchDaemonConfigRoot(parsedEffects.configDirectoryRoot) };
  const snapshotPath = resolve(input.snapshotPath);
  const dataDirRoot = resolve(input.dataDirRoot);
  if (snapshotPath === join(dataDirRoot, BENCH_DAEMON_DB_FILENAME)) throw new Error("snapshot must differ from live DB");
  IsoDatetimeStringSchema.parse(input.recordedAt);
  SourceRecordsManifestSchema.shape.producer_commit.parse(input.producerCommit);
  const loaded = await loadDatasetWindowWithIdentity("longmemeval_s", {
    dataDir: input.dataDir, pinnedMetaRoot: input.pinnedMetaRoot, offset: input.offset, limit: input.limit
  });
  // Reject surplus/missing dates as well as malformed values before any durable effects.
  loaded.questions.forEach(assertLongMemEvalTimeline);
  const dataset = SourceRecordsDatasetSchema.parse({ variant: "longmemeval_s", sha256: loaded.sha256,
    offset: input.offset, limit: input.limit, question_ids: loaded.questions.map((q) => q.question_id) });
  const successor = input.personaSuccessor === undefined ? undefined : preparePersonaSuccessor(input.personaSuccessor,
    { loaded, dataset, recordedAt: input.recordedAt, snapshotPath, dataDirRoot });
  return withSnapshotPublishLock(snapshotPath, () => withSnapshotPublishLock(join(dataDirRoot, "source-records-import"), async () => {
    bindPreparation(dataDirRoot, snapshotPath, dataset, input.recordedAt, successor?.binding);
    if (existsSync(sourceRecordsManifestPath(snapshotPath))) {
      const manifest = inspectSourceRecordsArtifact(snapshotPath).manifest;
      if (!isDeepStrictEqual(manifest.dataset, dataset) || manifest.recorded_at !== input.recordedAt ||
          !isDeepStrictEqual(manifest.persona_successor, successor?.binding)) {
        throw new Error("source_records manifest differs from preparation identity");
      }
      return manifest;
    }
    const daemon = await startBenchDaemon({ ...importEffects, dataDirRoot, embeddingMode: "disabled",
      fieldProjectionAdmissionMode: "explicit_checkpoint" });
    let sidecar: SourceRecordsSidecar;
    try {
      sidecar = await importMessages(daemon, loaded.questions, dataset, input.recordedAt, snapshotPath, successor);
      await daemon.checkpointFieldProjection();
    } finally {
      await daemon.shutdown();
    }
    successor?.assertUnchanged();
    checkpointAndCopyBenchDb(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME), snapshotPath);
    const manifest = sealSourceRecordsManifest({ schema_version: 2, artifact_domain: "source_records", dataset,
      recorded_at: input.recordedAt, message_count: sidecar.message_count, producer_commit: input.producerCommit,
      ...(successor === undefined ? {} : { persona_successor: successor.binding }),
      db_sha256: hashRegularFileNoFollow(snapshotPath), sidecar_sha256: hashRegularFileNoFollow(sourceRecordsSidecarPath(snapshotPath)) });
    atomicWriteJson(sourceRecordsManifestPath(snapshotPath), manifest);
    return inspectSourceRecordsArtifact(snapshotPath).manifest;
  }));
}

function bindPreparation(dataDir: string, snapshotPath: string, dataset: SourceRecordsDataset, recordedAt: string,
  personaSuccessor?: LongMemEvalPersonaSuccessor): void {
  const path = join(dataDir, "source-records-preparation.json");
  const expected = PreparationSchema.parse({ artifact_domain: "source_records", dataset,
    recorded_at: recordedAt, snapshot_path: snapshotPath,
    ...(personaSuccessor === undefined ? {} : { persona_successor: personaSuccessor }) });
  if (existsSync(path)) {
    const actual = PreparationSchema.parse(JSON.parse(readRegularFileNoFollow(path, 1024 * 1024).toString("utf8")));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("source_records preparation identity conflict");
  } else {
    if (existsSync(join(dataDir, BENCH_DAEMON_DB_FILENAME)) || existsSync(snapshotPath)) throw new Error("source_records preparation requires an isolated directory");
    mkdirSync(dataDir, { recursive: true });
    atomicWriteJson(path, expected);
  }
}

async function importMessages(daemon: BenchDaemonHandle, questions: readonly LongMemEvalQuestion[],
  dataset: SourceRecordsDataset, recordedAt: string, snapshotPath: string,
  successor?: PreparedPersonaSuccessor): Promise<SourceRecordsSidecar> {
  const writer = createSourceRecordsSidecarWriter(snapshotPath, {
    schema_version: 2, artifact_domain: "source_records", dataset, recorded_at: recordedAt,
    ...(successor === undefined ? {} : { persona_successor: successor.binding }),
    questions: questions.map((question) => ({ question_id: question.question_id,
      interpretation_clock: requireLongMemEvalTimestamp(question.question_date) }))
  });
  for (const question of questions) {
    const identity = buildLongMemEvalQuestionRuntimeIdentity(question.question_id);
    const workspace = await daemon.attachWorkspace(identity);
    try {
      for (const [sessionIndex, rawSession] of question.haystack_sessions.entries()) {
        // Strip scoring metadata before the existing round/message builders.
        const session = rawSession.map(({ role, content }) => ({ role, content }));
        const sourceObservedAt = requireLongMemEvalTimestamp(question.haystack_dates[sessionIndex]);
        const sessionId = question.haystack_session_ids[sessionIndex];
        if (sessionId === undefined || sessionId.length === 0) throw new Error("source session identity is missing");
        for (const [roundIndex, round] of pairSessionIntoRounds(session).entries()) {
          const built = buildLongMemEvalRoundMessages(session, round, `${question.question_id}-s${sessionIndex}-r${roundIndex}`);
          for (const [index, message] of built.entries()) {
            const messageIndex = round.messageIndices[index]!;
            const predecessor = successor === undefined ? undefined : personaPredecessor(successor, {
              questionId: question.question_id, sessionId, sessionIndex, roundIndex,
              messageId: message.message_id, messageIndex, role: message.role
            });
            const attribution = successor?.persona.source({ questionId: question.question_id, sessionIndex,
              messageIndex, role: message.role, content: message.content });
            const admitted = await workspace.importSourceRecord({ source_id: message.message_id,
              source_version: successor?.binding.source_version ?? dataset.sha256,
              content_bytes: message.content, recorded_at: recordedAt, event_time: null, valid_from: null, valid_to: null,
              ...(attribution === undefined ? {} : { attribution_context: attribution }),
              speaker: message.role, scope_class: "project", spans: deriveAddressableSpanViews(message.content) });
            if (predecessor !== undefined && predecessor.content_digest !== admitted.record.content_digest) {
              throw new AlayaError("CONFLICT", "persona successor changed original source bytes");
            }
            writer.append({ question_id: question.question_id, session_id: sessionId,
              session_index: sessionIndex, round_index: roundIndex, message_id: message.message_id,
              message_index: messageIndex, source_observed_at: sourceObservedAt,
              source_observation: { contract: "longmemeval-session-observation.v1",
                raw_date: question.haystack_dates[sessionIndex]! },
              ...(predecessor === undefined ? {} : { predecessor }),
              role: message.role, content_state: message.content.length === 0 ? "empty" : "retained", ...admitted });
          }
        }
      }
    } finally {
      await workspace.detach();
    }
  }
  const sidecar = writer.finish();
  if (successor !== undefined && sidecar.message_count !== successor.predecessors.size) {
    throw new AlayaError("CONFLICT", "persona successor must retain the parent's complete message membership");
  }
  return sidecar;
}
