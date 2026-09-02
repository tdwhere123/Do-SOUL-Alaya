import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { dirname, join } from "node:path";
import {
  boundedArtifactEntryExists,
  readBoundedCanonicalUtf8Artifact
} from "../../cache-audit/bounded-artifact-reader.js";
import {
  isAvailableSemanticArtifact,
  parseSemanticArtifact,
  SEMANTIC_ARTIFACT_MAX_BYTES,
  type SemanticArtifact,
  type SemanticArtifactState
} from "./contract.js";

export interface SemanticArtifactInspectResult {
  readonly status: SemanticArtifactState;
  readonly artifact?: SemanticArtifact;
  readonly reason?: string;
  readonly reservationToken?: string;
}

export function semanticArtifactPath(
  root: string,
  semanticKey: string,
  capability: string
): string {
  const capabilityId = encodeURIComponent(capability);
  return join(root, semanticKey.slice(0, 2), `${semanticKey}.${capabilityId}.json`);
}

export function reserveSemanticArtifact(
  root: string,
  semanticKey: string,
  capability: string
): string {
  const finalPath = semanticArtifactPath(root, semanticKey, capability);
  if (boundedArtifactEntryExists(finalPath)) {
    throw new Error("semantic artifact already admitted");
  }
  mkdirSync(dirname(finalPath), { recursive: true });
  const token = randomUUID();
  const reservePath = reservePathFor(finalPath);
  let descriptor: number;
  try {
    descriptor = openSync(reservePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (cause) {
    throw new Error("semantic artifact reservation is held", { cause });
  }
  try {
    writeSync(descriptor, `${token}\n`);
  } finally {
    closeSync(descriptor);
  }
  return token;
}

export function releaseSemanticArtifactReservation(
  root: string,
  semanticKey: string,
  capability: string,
  token: string
): void {
  const reservePath = reservePathFor(semanticArtifactPath(root, semanticKey, capability));
  if (readReserveToken(reservePath) !== token) {
    throw new Error("semantic artifact reservation token mismatch");
  }
  rmSync(reservePath, { force: true });
}

export function admitSemanticArtifact(input: {
  readonly root: string;
  readonly artifact: SemanticArtifact;
  readonly reservationToken: string;
}): void {
  const artifact = parseSemanticArtifact(input.artifact);
  const finalPath = semanticArtifactPath(input.root, artifact.semantic_key, artifact.capability);
  const reservePath = reservePathFor(finalPath);
  if (readReserveToken(reservePath) !== input.reservationToken) {
    throw new Error("semantic artifact reservation token mismatch");
  }
  if (boundedArtifactEntryExists(finalPath)) {
    throw new Error("semantic artifact already admitted");
  }
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.${input.reservationToken}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, finalPath);
  } catch (cause) {
    try { rmSync(tmpPath, { force: true }); } catch { /* keep the persistence error */ }
    throw cause;
  }
  rmSync(reservePath, { force: true });
}

export function inspectSemanticArtifact(
  root: string,
  semanticKey: string,
  capability: string
): SemanticArtifactInspectResult {
  const finalPath = semanticArtifactPath(root, semanticKey, capability);
  const reservePath = reservePathFor(finalPath);
  if (!boundedArtifactEntryExists(finalPath)) {
    if (!boundedArtifactEntryExists(reservePath)) return { status: "missing" };
    return { status: "reserved", reservationToken: readReserveToken(reservePath) };
  }
  try {
    const serialized = readBoundedCanonicalUtf8Artifact({
      path: finalPath,
      maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
      label: `semantic artifact ${semanticKey}`
    });
    const artifact = parseSemanticArtifact(JSON.parse(serialized) as unknown);
    if (artifact.semantic_key !== semanticKey || artifact.capability !== capability) {
      return { status: "invalid", reason: "path identity mismatch" };
    }
    if (artifact.admission_state === "invalid") {
      return { status: "invalid", artifact, reason: "admitted invalid" };
    }
    if (artifact.admission_state === "quarantined") {
      return { status: "quarantined", artifact, reason: artifact.quarantine_reason };
    }
    return { status: artifact.admission_state, artifact };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { status: "invalid", reason };
  }
}

export function listSemanticArtifactInventory(root: string): readonly SemanticArtifact[] {
  if (!boundedArtifactEntryExists(root)) return [];
  const artifacts: SemanticArtifact[] = [];
  for (const shard of readdirSync(root, { withFileTypes: true })) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/u.test(shard.name)) continue;
    const dir = join(root, shard.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const inspected = inspectPath(join(dir, entry.name));
      if (inspected.artifact !== undefined && isAvailableSemanticArtifact(inspected.artifact)) {
        artifacts.push(inspected.artifact);
      }
    }
  }
  return artifacts;
}

function inspectPath(path: string): SemanticArtifactInspectResult {
  try {
    const serialized = readBoundedCanonicalUtf8Artifact({
      path,
      maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
      label: "semantic artifact"
    });
    const artifact = parseSemanticArtifact(JSON.parse(serialized) as unknown);
    return { status: artifact.admission_state, artifact };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { status: "invalid", reason };
  }
}

function reservePathFor(finalPath: string): string {
  return `${finalPath}.reserve`;
}

function readReserveToken(reservePath: string): string | undefined {
  if (!boundedArtifactEntryExists(reservePath)) return undefined;
  try {
    return readBoundedCanonicalUtf8Artifact({
      path: reservePath,
      maxBytes: 128,
      label: "semantic artifact reservation"
    }).trim();
  } catch {
    return undefined;
  }
}
