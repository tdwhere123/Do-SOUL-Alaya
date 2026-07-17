import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  readC0DecisionReceipt,
  writeC0EvidenceArtifact,
  type C0DecisionReceipt
} from "../../longmemeval/extraction/c0/decision-receipt.js";
import {
  extractionCacheManifestPath
} from "../../longmemeval/extraction-cache-manifest.js";
import {
  preflightC0LockIsolation,
  type C0LockReadFilesystem,
  type C0LockNodeStat,
  type C0LockPreflight
} from "../../longmemeval/extraction/c0-lock-isolation.js";
import {
  hashC0RawShardInventory,
  type C0RawShardInventory
} from "../../longmemeval/extraction/c0/raw-inventory.js";
import {
  hashC0OccurrenceIndex,
  type C0ExtractionOccurrence
} from "../../longmemeval/extraction/c0/occurrence-index.js";
import {
  hashC0Replay,
  type C0ReplayEntry,
  type C0ReplayResult
} from "../../longmemeval/extraction/c0/replay.js";

const DECISION_FILENAME = "decision.json";
const PREFLIGHT_FILENAME = "lock-preflight.json";

type PidObservation =
  | Readonly<{ status: "not_recorded" }>
  | Readonly<{ status: "absent_current_namespace"; pid: number }>
  | Readonly<{ status: "present_current_namespace"; pid: number }>
  | Readonly<{ status: "unavailable"; pid: number }>;

type C0LockPreflightSummary = Omit<C0LockPreflight, "owner"> & Readonly<{
  owner: Omit<C0LockPreflight["owner"], "token_present">;
}>;

export interface C0LockPreflightEvidence {
  readonly schema_version: 1;
  readonly kind: "longmemeval_c0_lock_preflight";
  readonly decision_digest: string;
  readonly source_manifest_sha256: string;
  readonly current_source_manifest_sha256: string;
  readonly proof_status: "unproven";
  readonly pid_observation: PidObservation;
  readonly preflight: C0LockPreflightSummary;
}

interface C0LockPreflightRun {
  readonly evidencePath: string;
  readonly evidence: C0LockPreflightEvidence;
}

export function runC0LockPreflightCommand(
  args: ReadonlyArray<string>,
  dependencies: {
    readonly observePid?: (pid: number) => PidObservation;
    readonly writeStdout?: (text: string) => void;
    readonly writeStderr?: (text: string) => void;
  } = {}
): number {
  try {
    const run = buildC0LockPreflight({
      decisionPath: parseDecisionPath(args),
      observePid: dependencies.observePid ?? observeCurrentNamespacePid
    });
    writeC0EvidenceArtifact(run.evidencePath, renderJson(run.evidence));
    (dependencies.writeStdout ?? process.stdout.write.bind(process.stdout))(renderRun(run));
    return 0;
  } catch (error) {
    (dependencies.writeStderr ?? process.stderr.write.bind(process.stderr))(
      `alaya-bench-runner c0-lock-preflight: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}

function buildC0LockPreflight(input: {
  readonly decisionPath: string;
  readonly observePid: (pid: number) => PidObservation;
}): C0LockPreflightRun {
  const decisionPath = requireDecisionPath(input.decisionPath);
  const evidenceRoot = requireCanonicalDirectory(dirname(decisionPath), "C0 evidence root");
  const receipt = readC0DecisionReceipt(decisionPath);
  assertRebuildDecision(receipt);
  assertEvidenceBundleBindings(evidenceRoot, receipt);
  const sourceRoot = requireCanonicalDirectory(receipt.source_root, "C0 receipt source cache root");
  const currentManifestSha256 = hashBytes(readRegularFile(
    extractionCacheManifestPath(sourceRoot),
    "C0 source manifest"
  ));
  if (currentManifestSha256 !== receipt.source_manifest_sha256) {
    throw new Error("C0 source manifest changed after the reuse decision");
  }
  const unredactedPreflight = preflightC0LockIsolation({
    sourceCacheRoot: sourceRoot,
    targetEvidenceRoot: evidenceRoot,
    filesystem: nodeLockFilesystem
  });
  if (unredactedPreflight.source_cache_root !== sourceRoot ||
      unredactedPreflight.target_evidence_root !== evidenceRoot) {
    throw new Error("C0 lock preflight roots do not match the receipt-bound roots");
  }
  const pidObservation = unredactedPreflight.owner.pid === undefined
    ? { status: "not_recorded" as const }
    : input.observePid(unredactedPreflight.owner.pid);
  return {
    evidencePath: join(evidenceRoot, PREFLIGHT_FILENAME),
    evidence: {
      schema_version: 1,
      kind: "longmemeval_c0_lock_preflight",
      decision_digest: receipt.decision_digest,
      source_manifest_sha256: receipt.source_manifest_sha256,
      current_source_manifest_sha256: currentManifestSha256,
      proof_status: "unproven",
      pid_observation: pidObservation,
      preflight: redactPreflight(unredactedPreflight)
    }
  };
}

function parseDecisionPath(args: ReadonlyArray<string>): string {
  if (args.length !== 2 || args[0] !== "--c0-decision" || invalidFlagValue(args[1])) {
    throw new Error("usage: c0-lock-preflight --c0-decision <decision.json>");
  }
  return args[1]!;
}

function invalidFlagValue(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0 || value.startsWith("--");
}

function requireDecisionPath(path: string): string {
  const resolved = resolve(path);
  if (basename(resolved) !== DECISION_FILENAME) {
    throw new Error("--c0-decision must name the canonical decision.json artifact");
  }
  if (lstatSync(resolved).isSymbolicLink() || !lstatSync(resolved).isFile()) {
    throw new Error("--c0-decision must be an existing non-symlink regular file");
  }
  return realpathSync(resolved);
}

function requireCanonicalDirectory(path: string, label: string): string {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return realpathSync(path);
}

function assertRebuildDecision(receipt: C0DecisionReceipt): void {
  if (receipt.decision.action !== "rebuild") {
    throw new Error("C0 lock preflight requires a receipt-bound rebuild decision");
  }
}

function assertEvidenceBundleBindings(evidenceRoot: string, receipt: C0DecisionReceipt): void {
  const evidenceManifestSha256 = hashBytes(readRegularFile(
    join(evidenceRoot, "source-manifest.json"),
    "C0 evidence source manifest"
  ));
  if (evidenceManifestSha256 !== receipt.source_manifest_sha256) {
    throw new Error("C0 evidence source manifest does not match the reuse decision");
  }
  const inventory = readJsonArtifact(join(evidenceRoot, "raw-inventory.json"), "C0 raw inventory");
  assertArtifactDigest(
    inventory,
    receipt.raw_inventory_sha256,
    hashC0RawShardInventory(
      requireRecord(inventory.inventory, "C0 raw inventory payload") as unknown as C0RawShardInventory
    ),
    "C0 raw inventory"
  );
  const occurrences = readJsonArtifact(join(evidenceRoot, "occurrence-index.json"), "C0 occurrence index");
  assertArtifactDigest(
    occurrences,
    receipt.occurrence_index_sha256,
    hashC0OccurrenceIndex(requireArray(occurrences.occurrences, "C0 occurrence index payload")
      .map(readOccurrenceForDigest)),
    "C0 occurrence index"
  );
  const replay = readJsonArtifact(join(evidenceRoot, "replay-ledger.json"), "C0 replay ledger");
  assertReplayClosure(replay.closure, receipt);
  assertArtifactDigest(
    replay,
    receipt.decision.replay.ledgerSha256,
    hashC0Replay(readReplayForDigest(replay)),
    "C0 replay ledger"
  );
}

function assertArtifactDigest(
  artifact: Record<string, unknown>,
  expected: string,
  computed: string,
  label: string
): void {
  if (artifact.sha256 !== expected || computed !== expected) {
    throw new Error(`${label} does not match the reuse decision`);
  }
}

function assertReplayClosure(value: unknown, receipt: C0DecisionReceipt): void {
  const closure = requireRecord(value, "C0 replay closure");
  const expected = receipt.decision.replay;
  const fields = [
    "occurrenceCount", "accountedOccurrences", "elementCount", "accountedElements",
    "admitted", "deferred", "rejected", "invalid", "ledgerSha256"
  ] as const;
  if (fields.some((field) => closure[field] !== expected[field])) {
    throw new Error("C0 replay closure does not match the reuse decision");
  }
}

function readJsonArtifact(path: string, label: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(new TextDecoder().decode(readRegularFile(path, label))), label);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function readOccurrenceForDigest(value: unknown): C0ExtractionOccurrence {
  const occurrence = requireRecord(value, "C0 occurrence");
  return {
    id: requireString(occurrence.id, "C0 occurrence id"),
    evidenceRef: "",
    questionId: "",
    sessionIndex: 0,
    roundIndex: 0,
    sourceObservedAt: requireString(occurrence.source_observed_at, "C0 occurrence timestamp"),
    turnContent: "",
    cacheKey: requireString(occurrence.cache_key, "C0 occurrence cache key")
  };
}

function readReplayForDigest(artifact: Record<string, unknown>): C0ReplayResult {
  return {
    occurrences: requireArray(artifact.occurrences, "C0 replay occurrences").map((value) => {
      const occurrence = requireRecord(value, "C0 replay occurrence");
      const rawJsonSha256 = occurrence.raw_json_sha256;
      if (rawJsonSha256 !== null && typeof rawJsonSha256 !== "string") {
        throw new Error("C0 replay raw JSON digest must be a string or null");
      }
      return {
        occurrence: readOccurrenceForDigest(occurrence.occurrence),
        rawJsonSha256,
        entries: requireArray(occurrence.entries, "C0 replay entries").map(readReplayEntry)
      };
    }),
    closure: {} as C0ReplayResult["closure"]
  };
}

function readReplayEntry(value: unknown): C0ReplayEntry {
  const entry = requireRecord(value, "C0 replay entry");
  const index = entry.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("C0 replay entry index is invalid");
  }
  return {
    index,
    disposition: requireString(entry.disposition, "C0 replay disposition") as C0ReplayEntry["disposition"],
    stage: requireString(entry.stage, "C0 replay stage"),
    reason: requireString(entry.reason, "C0 replay reason")
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function redactPreflight(preflight: C0LockPreflight): C0LockPreflightSummary {
  const { token_present: _tokenPresent, ...owner } = preflight.owner;
  return { ...preflight, owner };
}

function readRegularFile(path: string, label: string): Uint8Array {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label} must be an existing non-symlink regular file`);
  }
  return readFileSync(path);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function observeCurrentNamespacePid(pid: number): PidObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unavailable", pid };
  try {
    process.kill(pid, 0);
    return { status: "present_current_namespace", pid };
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return { status: "absent_current_namespace", pid };
    if (hasErrorCode(error, "EPERM")) return { status: "present_current_namespace", pid };
    return { status: "unavailable", pid };
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderRun(run: C0LockPreflightRun): string {
  const { preflight, pid_observation: pidObservation } = run.evidence;
  return `C0 lock preflight=${preflight.proof_status} decision=${run.evidence.decision_digest}\n` +
    `  same_device=${preflight.same_device} destination_clear=${preflight.destination_clear} ` +
    `pid_observation=${pidObservation.status}\n` +
    `  evidence=${run.evidencePath} lock_migration=not_attempted\n`;
}

const nodeLockFilesystem: C0LockReadFilesystem = {
  canonicalPath: (path) => realpathSync(path),
  lstat: (path) => nodeStat(path),
  lstatIfPresent: (path) => {
    try {
      return nodeStat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  },
  readDirectory: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path)
};

function nodeStat(path: string): C0LockNodeStat {
  const stat = lstatSync(path);
  return {
    kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" :
      stat.isSymbolicLink() ? "symlink" : "other",
    device: stat.dev,
    size: stat.size
  };
}
