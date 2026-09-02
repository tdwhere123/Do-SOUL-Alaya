import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname, join } from "node:path";
import {
  boundedArtifactEntryExists,
  readBoundedCanonicalUtf8Artifact
} from "../../cache-audit/bounded-artifact-reader.js";
import {
  publishBytesExclusiveDurable,
  replaceBytesDurable
} from "../../fill/manifest/durable-exclusive-publication.js";
import { resolveExtractionCapability } from "./capability.js";
import {
  isAvailableSemanticArtifact,
  parseSemanticArtifact,
  SEMANTIC_ARTIFACT_MAX_BYTES,
  type SemanticArtifact,
  type SemanticArtifactSourceBinding,
  type SemanticArtifactState
} from "./contract.js";

export const SEMANTIC_ARTIFACT_ROOT_KIND = "assertion_semantic_artifact_root_v1";

export interface SemanticArtifactInspectResult {
  readonly status: SemanticArtifactState;
  readonly artifact?: SemanticArtifact;
  readonly reason?: string;
}

export function semanticArtifactPath(
  root: string,
  semanticKey: string,
  capability: string
): string {
  const capabilityId = encodeURIComponent(capability);
  return join(root, semanticKey.slice(0, 2), `${semanticKey}.${capabilityId}.json`);
}

export function ensureSemanticArtifactRoot(root: string): void {
  if (boundedArtifactEntryExists(join(root, "manifest.json")) ||
      boundedArtifactEntryExists(join(root, "extraction-cache-manifest.json"))) {
    throw new Error("refusing to write a semantic artifact root over a legacy extraction cache");
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const marker = join(root, "ROOT_KIND");
  if (!boundedArtifactEntryExists(marker)) {
    publishBytesExclusiveDurable({
      destination: marker,
      bytes: Buffer.from(`${SEMANTIC_ARTIFACT_ROOT_KIND}\n`, "utf8"),
      ownerIdentity: SEMANTIC_ARTIFACT_ROOT_KIND,
      temporaryDirectory: join(root, ".tmp"),
      allowExistingExact: true
    });
  }
}

export function persistRawArtifact(root: string, rawJson: string): string {
  ensureSemanticArtifactRoot(root);
  const digest = createHash("sha256").update(rawJson, "utf8").digest("hex");
  const destination = rawPath(root, digest);
  mkdirSync(dirname(destination), { recursive: true });
  publishBytesExclusiveDurable({
    destination,
    bytes: Buffer.from(rawJson, "utf8"),
    ownerIdentity: digest,
    temporaryDirectory: join(root, ".tmp"),
    allowExistingExact: true
  });
  return digest;
}

export function readPersistedRawArtifact(root: string, digest: string): string {
  return readBoundedCanonicalUtf8Artifact({
    path: rawPath(root, digest),
    maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
    label: `raw artifact ${digest}`
  });
}

export function reserveSemanticArtifact(
  root: string,
  semanticKey: string,
  capability: string
): string {
  ensureSemanticArtifactRoot(root);
  resolveExtractionCapability(capability);
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

export function reclaimAbandonedReservation(
  root: string,
  semanticKey: string,
  capability: string
): void {
  const finalPath = semanticArtifactPath(root, semanticKey, capability);
  if (boundedArtifactEntryExists(finalPath)) return;
  rmSync(reservePathFor(finalPath), { force: true });
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
  resolveExtractionCapability(artifact.capability);
  const finalPath = semanticArtifactPath(input.root, artifact.semantic_key, artifact.capability);
  const reservePath = reservePathFor(finalPath);
  if (readReserveToken(reservePath) !== input.reservationToken) {
    throw new Error("semantic artifact reservation token mismatch");
  }
  mkdirSync(dirname(finalPath), { recursive: true });
  publishBytesExclusiveDurable({
    destination: finalPath,
    bytes: Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8"),
    ownerIdentity: input.reservationToken,
    temporaryDirectory: join(input.root, ".tmp")
  });
  rmSync(reservePath, { force: true });
  writeBindings(input.root, artifact.semantic_key, artifact.capability, artifact.source_bindings);
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
    return { status: "reserved" };
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

export function recordedSourceBindings(
  root: string,
  semanticKey: string,
  capability: string
): readonly SemanticArtifactSourceBinding[] {
  const path = bindingsPath(root, semanticKey, capability);
  if (!boundedArtifactEntryExists(path)) return [];
  const parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({
    path,
    maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
    label: "semantic artifact bindings"
  })) as { bindings?: SemanticArtifactSourceBinding[] };
  return parsed.bindings ?? [];
}

export function recordSourceBinding(
  root: string,
  semanticKey: string,
  capability: string,
  binding: SemanticArtifactSourceBinding
): void {
  if (binding.semanticKey !== semanticKey) {
    throw new Error("binding semantic key mismatch");
  }
  const existing = recordedSourceBindings(root, semanticKey, capability);
  if (existing.some((item) => sameBinding(item, binding))) return;
  writeBindings(root, semanticKey, capability, [...existing, binding]);
}

function writeBindings(
  root: string,
  semanticKey: string,
  capability: string,
  bindings: readonly SemanticArtifactSourceBinding[]
): void {
  const destination = bindingsPath(root, semanticKey, capability);
  mkdirSync(dirname(destination), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify({ semantic_key: semanticKey, capability, bindings }, null, 2)}\n`, "utf8");
  const publication = {
    destination,
    bytes,
    ownerIdentity: `${semanticKey}:${capability}:bindings:${bindings.length}`,
    temporaryDirectory: join(root, ".tmp")
  };
  if (boundedArtifactEntryExists(destination)) {
    replaceBytesDurable(publication);
    return;
  }
  publishBytesExclusiveDurable(publication);
}

function sameBinding(
  left: SemanticArtifactSourceBinding,
  right: SemanticArtifactSourceBinding
): boolean {
  return left.sourceCorpusIdentity === right.sourceCorpusIdentity &&
    left.locator.assertion_id === right.locator.assertion_id &&
    left.locator.start === right.locator.start &&
    left.locator.end === right.locator.end;
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

function rawPath(root: string, digest: string): string {
  return join(root, "raw", digest.slice(0, 2), `${digest}.json`);
}

function bindingsPath(root: string, semanticKey: string, capability: string): string {
  return join(root, "bindings", `${semanticKey}.${encodeURIComponent(capability)}.json`);
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
