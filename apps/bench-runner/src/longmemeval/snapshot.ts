import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { getCurrentSchemaSummary, initDatabase } from "@do-soul/alaya-storage";
import { RECALL_PIPELINE_VERSION } from "../shared/version.js";
import type { LongMemEvalSeedDropReasons } from "./seed-drop-reasons.js";
import type { LongMemEvalRunProvenance } from "./provenance/run.js";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  type ExtractionRequestProfile
} from "./extraction-cache-manifest.js";
import type { SnapshotArtifactIntegrity } from "./snapshot/integrity.js";
import { validateSnapshotManifest } from "./snapshot/manifest-validation.js";
import { parseSnapshotSidecar } from "./snapshot/sidecar-validation.js";
export { deriveSnapshotAttribution } from "./snapshot/attribution.js";

/**
 * @anchor longmemeval-recall-eval-snapshot
 *
 * A seeded-DB snapshot lets the recall feedback loop (recall-eval) skip BOTH
 * the slow LLM extraction (Layer 1, already frozen in the extraction cache)
 * AND the per-question materialization (Layer 2, ~18k DB row writes/Q). The
 * snapshot is a checkpointed copy of the bench daemon's seeded `alaya.db`,
 * paired with:
 *   - a sidecar JSON (the per-question scoring sidecar the seed loop built in
 *     memory and otherwise discards) so recall-eval can score without
 *     re-seeding, and
 *   - a manifest binding the snapshot to the code/migration version that
 *     produced it, so a recall/materialization pipeline change invalidates the
 *     snapshot loudly instead of silently scoring against stale materialized
 *     state.
 *
 * recall-eval restores a WORKING COPY of the snapshot DB (recall appends
 * delivery / lens events) and never mutates the frozen snapshot file.
 *
 * cross-file: apps/bench-runner/src/harness/daemon.ts startBenchDaemon
 *   (dataDirRoot — the daemon opens `<dataDirRoot>/alaya.db`)
 * cross-file: apps/bench-runner/src/longmemeval/recall-eval.ts (consumer)
 * cross-file: apps/bench-runner/src/longmemeval/runner.ts (producer hook)
 */

export const RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION = 2;
/** Filename of the daemon's seeded SQLite DB inside a dataDirRoot. */
export const BENCH_DAEMON_DB_FILENAME = "alaya.db";

export type LongMemEvalSnapshotSidecarObjectKind =
  | "memory_entry"
  | "synthesis_capsule";

/**
 * One persisted scoring-sidecar entry. Mirrors the in-memory
 * LongMemEvalSidecarEntry the seed loop builds (runner.ts), keyed by
 * `${objectKind}:${objectId}` on read-back.
 */
export interface LongMemEvalSnapshotSidecarEntry {
  readonly objectId: string;
  readonly objectKind: LongMemEvalSnapshotSidecarObjectKind;
  readonly sessionId: string;
  readonly hasAnswer: boolean;
}

/** Per-question persisted recall-scoring inputs. */
export interface LongMemEvalSnapshotQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly questionDate: string;
  /** answer_session_ids from the dataset — the recall@k session filter. */
  readonly answerSessionIds: readonly string[];
  /** Sidecar entries seeded for this question (memory_entry + synthesis). */
  readonly sidecar: readonly LongMemEvalSnapshotSidecarEntry[];
  /** Workspace the question's memories were seeded under (recall isolation). */
  readonly workspaceId: string;
  /** Run id the question's workspace was attached with. */
  readonly runId: string;
  /** Answer-turn seed failures that explain a no-gold question. */
  readonly answerSeedDropReasons?: LongMemEvalSeedDropReasons;
}

/**
 * The persisted sidecar payload. Written next to the snapshot DB so recall-eval
 * has every input the seed loop produced in memory (sidecar, gold sessions,
 * workspace ids) without re-running the seed loop.
 */
export interface LongMemEvalSnapshotSidecarFile {
  readonly schema_version: number;
  readonly variant: string;
  readonly questions: readonly LongMemEvalSnapshotQuestion[];
}

/**
 * The snapshot manifest. Binds the DB+sidecar to the code/migration version
 * that produced them. recall-eval refuses a snapshot whose recall pipeline
 * version or schema migration version disagrees with the running binary.
 */
export interface LongMemEvalSnapshotManifest {
  readonly schema_version: number;
  /** Dataset variant the snapshot was seeded from (e.g. "longmemeval_s"). */
  readonly variant: string;
  /** Question count seeded into the snapshot DB. */
  readonly question_count: number;
  /** RECALL_PIPELINE_VERSION at seed time — recall-eval must match it. */
  readonly recall_pipeline_version: string;
  /** SQLite max migration version of the seeded DB — recall-eval must match. */
  readonly schema_migration_version: number;
  /** bench-runner package version that produced the snapshot. */
  readonly bench_runner_version: string;
  /** alaya commit sha7 at seed time (provenance). */
  readonly alaya_commit: string;
  /** Filename of the snapshot DB beside this manifest. */
  readonly db_filename: string;
  /** Filename of the sidecar JSON beside this manifest. */
  readonly sidecar_filename: string;
  /** ISO 8601 build time. */
  readonly built_at: string;
  /**
   * Inherited extraction provenance, copied from the extraction-fill manifest
   * (gate-only fields recall-eval does NOT recompute). Present when the seed
   * run resolved an extraction-cache manifest; null otherwise.
   */
  readonly extraction_provenance: SnapshotExtractionProvenance | null;
  readonly artifact_integrity?: SnapshotArtifactIntegrity;
  readonly run_provenance?: LongMemEvalRunProvenance;
  readonly question_id_digest?: string;
  readonly dataset_sha256?: string;
  readonly attribution?: Readonly<{
    status: "attributed" | "legacy_unattributed";
    gate_eligible: boolean;
  }>;
}

/**
 * Gate-only extraction provenance recall-eval inherits rather than recomputes
 * (the recall fast loop never re-extracts, so it cannot produce these). Mirrors
 * the load-bearing fields of the extraction-cache manifest.
 */
interface SnapshotExtractionProvenanceBase {
  readonly manifest_sha256: string;
  readonly extraction_model: string;
  readonly provider_url: string;
  readonly system_prompt_sha256: string;
  readonly cache_key_algo: string;
  readonly dataset: string;
  readonly dataset_revision: string;
  readonly coverage?: number;
  readonly cached_turns?: number;
  readonly requested_turns?: number;
}

export interface SnapshotExtractionProvenanceV1
  extends SnapshotExtractionProvenanceBase {
  readonly schema_version: 1;
  readonly model_family?: never;
  readonly request_profile?: never;
}

export interface SnapshotExtractionProvenanceV2
  extends SnapshotExtractionProvenanceBase {
  readonly schema_version: 2;
  readonly model_family: string;
  readonly request_profile?: never;
}

export interface SnapshotExtractionProvenanceV3
  extends SnapshotExtractionProvenanceBase {
  readonly schema_version: typeof EXTRACTION_CACHE_MANIFEST_VERSION;
  readonly model_family: string;
  readonly request_profile: ExtractionRequestProfile;
}

export type SnapshotExtractionProvenance =
  | SnapshotExtractionProvenanceV1
  | SnapshotExtractionProvenanceV2
  | SnapshotExtractionProvenanceV3;

export function snapshotManifestPath(snapshotDbPath: string): string {
  return `${snapshotDbPath}.manifest.json`;
}

export function snapshotSidecarPath(snapshotDbPath: string): string {
  return `${snapshotDbPath}.sidecar.json`;
}

/**
 * Read the SQLite max migration version off a DB file (the version recall-eval
 * binds the snapshot to). Opens via the storage connection cache; never closes
 * the connection (the cache owns the lifecycle).
 */
export function readSchemaMigrationVersion(dbPath: string): number {
  const db = initDatabase({ filename: dbPath });
  const summary = getCurrentSchemaSummary(db);
  return summary.persistedMaxVersion ?? summary.knownMaxVersion;
}

/**
 * Checkpoint the WAL of a live bench DB then copy it (+ -wal / -shm sidecars)
 * to a frozen snapshot path. MUST run while the daemon connection is still open
 * so `wal_checkpoint(TRUNCATE)` flushes every committed frame into the main DB
 * file before the copy — under the bench fast-pragma (synchronous=NORMAL) an
 * un-checkpointed copy would lose the last frames.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts applyBenchFastPragmaIfRequested
 */
export function checkpointAndCopyBenchDb(
  liveDbPath: string,
  snapshotDbPath: string
): void {
  const db = initDatabase({ filename: liveDbPath });
  // TRUNCATE checkpoint flushes the WAL into the main DB and resets the WAL
  // file to zero length, so a plain file copy of the .db captures everything.
  db.connection.pragma("wal_checkpoint(TRUNCATE)");
  mkdirSync(dirname(snapshotDbPath), { recursive: true });
  atomicCopy(liveDbPath, snapshotDbPath);
}

/**
 * Restore a frozen snapshot DB into a working dataDirRoot the daemon will open.
 * Copies the snapshot to `<dataDirRoot>/alaya.db` (a WORKING COPY — recall
 * appends delivery/lens events, which must never touch the frozen snapshot).
 * Returns the dataDirRoot so the caller threads it into startBenchDaemon.
 */
export function restoreSnapshotToDataDir(input: {
  readonly snapshotDbPath: string;
  readonly dataDirRoot: string;
}): string {
  if (!existsSync(input.snapshotDbPath)) {
    throw new Error(
      `recall-eval snapshot DB not found at ${input.snapshotDbPath}`
    );
  }
  mkdirSync(input.dataDirRoot, { recursive: true });
  const workingDbPath = join(input.dataDirRoot, BENCH_DAEMON_DB_FILENAME);
  // Clear any stale WAL/SHM from a previous restore so the daemon opens a clean
  // copy (a leftover -wal could re-introduce another run's appended frames).
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${workingDbPath}${suffix}`, { force: true });
  }
  atomicCopy(input.snapshotDbPath, workingDbPath);
  return input.dataDirRoot;
}

export function writeSnapshotManifest(
  snapshotDbPath: string,
  manifest: LongMemEvalSnapshotManifest
): void {
  atomicWriteJson(snapshotManifestPath(snapshotDbPath), manifest);
}

export function writeSnapshotSidecar(
  snapshotDbPath: string,
  sidecar: LongMemEvalSnapshotSidecarFile
): void {
  const filePath = snapshotSidecarPath(snapshotDbPath);
  atomicWriteJson(filePath, parseSnapshotSidecar(
    sidecar,
    filePath,
    RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION
  ));
}

export function readSnapshotManifest(
  snapshotDbPath: string
): LongMemEvalSnapshotManifest {
  const filePath = snapshotManifestPath(snapshotDbPath);
  if (!existsSync(filePath)) {
    throw new Error(
      `recall-eval snapshot manifest not found at ${filePath}; produce one by ` +
        "seeding with --snapshot-out (longmemeval) so recall-eval can bind the " +
        "snapshot to its code/migration version."
    );
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return validateSnapshotManifest(parsed, filePath);
}

export function readSnapshotSidecar(
  snapshotDbPath: string
): LongMemEvalSnapshotSidecarFile {
  const filePath = snapshotSidecarPath(snapshotDbPath);
  if (!existsSync(filePath)) {
    throw new Error(`recall-eval snapshot sidecar not found at ${filePath}`);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if ((parsed as { schema_version?: unknown })?.schema_version !== RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION) {
    throw new Error(
      `recall-eval snapshot sidecar at ${filePath} has unsupported schema_version`
    );
  }
  return parseSnapshotSidecar(parsed, filePath, RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION);
}

export function snapshotQuestionIdDigest(
  questions: readonly Pick<LongMemEvalSnapshotQuestion, "questionId">[]
): string {
  const hash = createHash("sha256");
  for (const question of questions) {
    const bytes = Buffer.from(question.questionId, "utf8");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(size).update(bytes);
  }
  return hash.digest("hex");
}

export function assertSnapshotConsumerBinding(input: {
  readonly snapshotDbPath: string;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly variant: string;
}): void {
  const expectedDb = basename(input.snapshotDbPath);
  if (input.manifest.variant !== input.variant || input.sidecar.variant !== input.variant) {
    throw new Error("recall-eval snapshot variant does not match requested variant");
  }
  if (
    input.manifest.db_filename !== expectedDb ||
    input.manifest.sidecar_filename !== `${expectedDb}.sidecar.json`
  ) throw new Error("recall-eval snapshot filename binding mismatch");
  if (input.manifest.question_count !== input.sidecar.questions.length) {
    throw new Error("recall-eval snapshot question count binding mismatch");
  }
  if (new Set(input.sidecar.questions.map((question) => question.questionId)).size !== input.sidecar.questions.length) {
    throw new Error("recall-eval snapshot contains duplicate question ids");
  }
  const digest = snapshotQuestionIdDigest(input.sidecar.questions);
  if (input.manifest.question_id_digest !== undefined && input.manifest.question_id_digest !== digest) {
    throw new Error("recall-eval snapshot question digest binding mismatch");
  }
  if (input.manifest.attribution?.status === "attributed" && input.manifest.question_id_digest !== digest) {
    throw new Error("recall-eval attributed snapshot requires a bound question digest");
  }
  const provenanceDataset =
    input.manifest.run_provenance?.question_manifest?.dataset_sha256 ??
    input.manifest.run_provenance?.extraction_cache?.dataset_revision;
  if (
    input.manifest.dataset_sha256 !== undefined &&
    provenanceDataset !== undefined &&
    /^[a-f0-9]{64}$/u.test(provenanceDataset) &&
    input.manifest.dataset_sha256 !== provenanceDataset
  ) throw new Error("recall-eval snapshot dataset binding mismatch");
}

/**
 * Version-binding guard. Throws when a snapshot's recall-pipeline or schema
 * migration version disagrees with the running binary — a materialization /
 * recall pipeline change makes the frozen materialized state stale, so the
 * snapshot must be rebuilt rather than silently scored against.
 */
export function assertSnapshotVersionMatch(
  manifest: LongMemEvalSnapshotManifest,
  restoredDbPath: string
): void {
  if (manifest.recall_pipeline_version !== RECALL_PIPELINE_VERSION) {
    throw new Error(
      "[recall-eval] snapshot recall_pipeline_version " +
        `"${manifest.recall_pipeline_version}" != running binary ` +
        `"${RECALL_PIPELINE_VERSION}". The recall/materialization pipeline ` +
        "changed since the snapshot was seeded; rebuild the snapshot " +
        "(seed with --snapshot-out) before recall-eval."
    );
  }
  const restoredSchemaVersion = readSchemaMigrationVersion(restoredDbPath);
  if (restoredSchemaVersion !== manifest.schema_migration_version) {
    throw new Error(
      "[recall-eval] snapshot schema_migration_version " +
        `${manifest.schema_migration_version} != restored DB migration ` +
        `version ${restoredSchemaVersion}. The schema migrated since the ` +
        "snapshot was seeded; rebuild the snapshot before recall-eval."
    );
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function atomicCopy(fromPath: string, toPath: string): void {
  mkdirSync(dirname(toPath), { recursive: true });
  const tmpPath = `${toPath}.${randomUUID()}.tmp`;
  copyFileSync(fromPath, tmpPath);
  renameSync(tmpPath, toPath);
}
