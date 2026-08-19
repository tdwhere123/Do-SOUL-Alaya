import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DIAGNOSTIC_LOOP_PHASES,
  isDiagnosticLoopPhase,
  phasesFrom,
  type DiagnosticLoopPhase
} from "./phases.js";
import type { DiagnosticLoopCheckpoint } from "./types.js";
import { sha256Utf8 } from "./identity.js";
import { isSha256Hex } from "./identity.js";

const CHECKPOINT_KEYS = [
  "schema_version", "kind", "phase", "status", "identity_digest",
  "content_identity", "depends_on", "physical_calls", "avoided_work",
  "artifact_paths", "details", "completed_at", "checkpoint_digest"
] as const;
const AVOIDED_KEYS = [
  "phasesSkipped", "providerCallsAvoided", "questionsSkipped", "snapshotsReused"
] as const;

export function checkpointPath(workRoot: string, phase: DiagnosticLoopPhase): string {
  return join(workRoot, "checkpoints", `${phase}.json`);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function writeCheckpointAtomic(
  path: string,
  checkpoint: DiagnosticLoopCheckpoint
): void {
  writeJsonAtomic(path, checkpoint);
}

export function checkpointDigest(
  checkpoint: Omit<DiagnosticLoopCheckpoint, "checkpoint_digest">
): string {
  return sha256Utf8(JSON.stringify(checkpoint));
}

export function readCheckpoint(path: string): DiagnosticLoopCheckpoint {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertCheckpointShape(parsed, path);
  const checkpoint = parsed;
  const { checkpoint_digest: actual, ...body } = checkpoint;
  if (actual !== checkpointDigest(body)) {
    throw new Error(`diagnostic-loop checkpoint digest mismatch: ${path}`);
  }
  return checkpoint;
}

function assertCheckpointShape(
  value: unknown,
  path: string
): asserts value is DiagnosticLoopCheckpoint {
  if (!isRecord(value) || !hasExactKeys(value, CHECKPOINT_KEYS) ||
      value.schema_version !== 2 || value.kind !== "diagnostic_loop_checkpoint" ||
      typeof value.phase !== "string" || !isDiagnosticLoopPhase(value.phase) ||
      (value.status !== "completed" && value.status !== "failed") ||
      !isDigest(value.identity_digest) || !isDigest(value.content_identity) ||
      !isDigest(value.checkpoint_digest) || !isCount(value.physical_calls) ||
      !isArtifactRecord(value.phase, value.artifact_paths) || !isRecord(value.details) ||
      !isNoProviderReceipt(value.details.no_provider_call_receipt, value.physical_calls) ||
      !isDependencyRecord(value.depends_on) || !isAvoidedWork(value.avoided_work) ||
      !isIsoTimestamp(value.completed_at)) {
    throw new Error(`invalid diagnostic-loop checkpoint: ${path}`);
  }
}

function isNoProviderReceipt(value: unknown, physicalCalls: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version", "kind", "provider_port", "physical_calls"
  ])) return false;
  return value.schema_version === 1 && value.provider_port === "absent" &&
    value.physical_calls === 0 && physicalCalls === 0 &&
    (value.kind === "credentialless_environment" ||
      value.kind === "injected_no_provider_port" ||
      value.kind === "internal_no_provider_port");
}

function isArtifactRecord(phase: DiagnosticLoopPhase, value: unknown): boolean {
  if (!isStringRecord(value, true)) return false;
  const keys: Record<DiagnosticLoopPhase, readonly string[]> = {
    preflight: [],
    authority_cache: ["cacheRoot"],
    extraction: ["cacheRoot"],
    snapshot: ["snapshot"],
    control_recall: ["snapshot", "kpi", "report", "diagnostics"],
    treatment_recall: ["snapshot", "kpi", "report", "diagnostics"],
    miss_ledger: ["missLedger"],
    report: ["report"]
  };
  return hasExactKeys(value, keys[phase]);
}

function isAvoidedWork(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, AVOIDED_KEYS) &&
    AVOIDED_KEYS.every((key) => isCount(value[key]));
}

function isDependencyRecord(value: unknown): boolean {
  return isStringRecord(value, false) && Object.entries(value).every(
    ([phase, digest]) => isDiagnosticLoopPhase(phase) && isDigest(digest)
  );
}

function isStringRecord(value: unknown, requireNonEmpty: boolean): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([key, nested]) =>
    key.length > 0 && typeof nested === "string" &&
    (!requireNonEmpty || nested.length > 0));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && isSha256Hex(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

export function loadCompletedCheckpoints(
  workRoot: string,
  identityDigest: string
): Map<DiagnosticLoopPhase, DiagnosticLoopCheckpoint> {
  const loaded = new Map<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>();
  for (const phase of DIAGNOSTIC_LOOP_PHASES) {
    const path = checkpointPath(workRoot, phase);
    if (!existsSync(path)) continue;
    const checkpoint = readCheckpoint(path);
    if (checkpoint.phase !== phase) {
      throw new Error(`diagnostic-loop checkpoint phase mismatch: ${path}`);
    }
    if (checkpoint.identity_digest !== identityDigest) {
      throw new Error(
        `checkpoint identity mismatch at ${phase}: ` +
        `expected ${identityDigest}, found ${checkpoint.identity_digest}`
      );
    }
    assertDependencies(phase, checkpoint, loaded);
    if (checkpoint.status === "failed") {
      invalidateFromPhase(workRoot, phase);
      break;
    }
    loaded.set(phase, checkpoint);
  }
  return loaded;
}

function assertDependencies(
  phase: DiagnosticLoopPhase,
  checkpoint: DiagnosticLoopCheckpoint,
  prior: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>
): void {
  const expected = dependencyManifest(prior);
  if (JSON.stringify(checkpoint.depends_on) !== JSON.stringify(expected)) {
    throw new Error(`diagnostic-loop checkpoint dependency mismatch at ${phase}`);
  }
}

export function invalidateFromPhase(
  workRoot: string,
  start: DiagnosticLoopPhase
): void {
  for (const phase of phasesFrom(start)) {
    const path = checkpointPath(workRoot, phase);
    if (existsSync(path)) rmSync(path);
  }
}

export function emptyAvoidedWork(): DiagnosticLoopCheckpoint["avoided_work"] {
  return {
    phasesSkipped: 0,
    providerCallsAvoided: 0,
    questionsSkipped: 0,
    snapshotsReused: 0
  };
}

export function addAvoidedWork(
  left: DiagnosticLoopCheckpoint["avoided_work"],
  right: Partial<DiagnosticLoopCheckpoint["avoided_work"]> | undefined
): DiagnosticLoopCheckpoint["avoided_work"] {
  return {
    phasesSkipped: left.phasesSkipped + (right?.phasesSkipped ?? 0),
    providerCallsAvoided: left.providerCallsAvoided + (right?.providerCallsAvoided ?? 0),
    questionsSkipped: left.questionsSkipped + (right?.questionsSkipped ?? 0),
    snapshotsReused: left.snapshotsReused + (right?.snapshotsReused ?? 0)
  };
}

export function dependencyManifest(
  checkpoints: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>
): Readonly<Record<string, string>> {
  const depends: Record<string, string> = {};
  for (const [phase, checkpoint] of checkpoints) {
    depends[phase] = checkpoint.content_identity;
  }
  return depends;
}
