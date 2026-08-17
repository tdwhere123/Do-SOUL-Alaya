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
  phasesFrom,
  type DiagnosticLoopPhase
} from "./phases.js";
import type { DiagnosticLoopCheckpoint } from "./types.js";

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

export function readCheckpoint(path: string): DiagnosticLoopCheckpoint {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DiagnosticLoopCheckpoint>;
  if (parsed.schema_version !== 1 || parsed.kind !== "diagnostic_loop_checkpoint") {
    throw new Error(`invalid diagnostic-loop checkpoint: ${path}`);
  }
  if (parsed.phase === undefined || parsed.status === undefined) {
    throw new Error(`diagnostic-loop checkpoint missing phase/status: ${path}`);
  }
  return parsed as DiagnosticLoopCheckpoint;
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
    if (checkpoint.identity_digest !== identityDigest) {
      throw new Error(
        `checkpoint identity mismatch at ${phase}: ` +
        `expected ${identityDigest}, found ${checkpoint.identity_digest}`
      );
    }
    if (checkpoint.status === "completed") loaded.set(phase, checkpoint);
  }
  return loaded;
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
