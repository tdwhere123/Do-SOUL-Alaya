import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NO_FOLLOW_OPEN_FLAG } from "../../../fs/open-flags.js";
import {
  boundedArtifactEntryExists,
  readBoundedCanonicalUtf8Artifact,
  readBoundedStableRegularFile,
  readRootBoundCanonicalUtf8Artifact,
  withRootBoundDirectory
} from "../../cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from
  "../../fill/manifest/durable-exclusive-publication.js";
import type { ExtractionCacheWriteLease } from
  "../../fill/manifest/fill-root-guard.js";
import {
  unwrapVerifiedSemanticArtifactAdmission,
  type VerifiedSemanticArtifactAdmission
} from "./verified-admission.js";
import {
  assertSemanticArtifactCompatibility,
  type SemanticAdmissionIdentity
} from "./admission-identity.js";
import {
  digestBindingSet,
  recordedSourceBindings,
  writeArtifactBindings
} from "./bindings.js";
import { resolveExtractionCapability } from "./capability.js";
import {
  isAvailableSemanticArtifact,
  parseSemanticArtifact,
  SEMANTIC_ARTIFACT_MAX_BYTES,
  type SemanticArtifact,
  type SemanticArtifactState
} from "./contract.js";
import {
  artifactFilename,
  artifactPrefix,
  assertSemanticPathIdentity,
  parseArtifactFilename
} from "./derived-path.js";
import {
  consumeSemanticArtifactReservation,
  createSemanticArtifactReservation,
  readReserveOwnerFromFd,
  recoverMalformedSemanticReservations
} from "./reservation.js";

export const SEMANTIC_ARTIFACT_ROOT_KIND = "assertion_semantic_artifact_root_v1";
export { recordSourceBinding, recordedSourceBindings } from "./bindings.js";
export { materializeDerivedReplayFromRaw } from "./derived-replay.js";
export {
  reclaimAbandonedReservation,
  recoverMalformedSemanticReservations,
  releaseSemanticArtifactReservation
} from "./reservation.js";
export { semanticArtifactPath } from "./derived-path.js";

export interface SemanticArtifactInspectResult {
  readonly status: SemanticArtifactState;
  readonly artifact?: SemanticArtifact;
  readonly reason?: string;
}

export function ensureSemanticArtifactRoot(root: string): void {
  withRootBoundDirectory({ root, createRoot: true, label: "semantic artifact root" }, (stableRoot) => {
    if (entryExists(stableRoot, "manifest.json") ||
        entryExists(stableRoot, "extraction-cache-manifest.json")) {
      throw new Error("refusing to write a semantic artifact root over a legacy extraction cache");
    }
    withRootBoundDirectory({
      root: stableRoot, segments: [".tmp"], createSegments: true,
      label: "semantic artifact temporary root"
    }, (temporaryDirectory) => {
      const marker = `${stableRoot}/ROOT_KIND`;
      if (!entryExists(stableRoot, "ROOT_KIND")) {
        publishBytesExclusiveDurable({
          destination: marker,
          bytes: Buffer.from(`${SEMANTIC_ARTIFACT_ROOT_KIND}\n`, "utf8"),
          ownerIdentity: SEMANTIC_ARTIFACT_ROOT_KIND,
          temporaryDirectory,
          allowExistingExact: true
        });
      }
      const rootKind = readBoundedCanonicalUtf8Artifact({
        path: marker,
        maxBytes: Buffer.byteLength(`${SEMANTIC_ARTIFACT_ROOT_KIND}\n`, "utf8"),
        label: "semantic artifact root kind"
      });
      if (rootKind !== `${SEMANTIC_ARTIFACT_ROOT_KIND}\n`) {
        throw new Error("semantic artifact root has a foreign ROOT_KIND marker");
      }
    });
  });
}

export function persistRawArtifact(root: string, rawJson: string): string {
  const bytes = Buffer.from(rawJson, "utf8");
  if (bytes.byteLength > SEMANTIC_ARTIFACT_MAX_BYTES) {
    throw new Error("raw artifact exceeds its size limit");
  }
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== rawJson) {
    throw new Error("raw artifact UTF-8 bytes are not canonical");
  }
  ensureSemanticArtifactRoot(root);
  const digest = createHash("sha256").update(bytes).digest("hex");
  withPublicationDirectories(root, ["raw", digest.slice(0, 2)], "raw artifact", (dir, tmp) => {
    publishBytesExclusiveDurable({
      destination: `${dir}/${digest}.json`,
      bytes,
      ownerIdentity: digest,
      temporaryDirectory: tmp,
      allowExistingExact: true
    });
  });
  return digest;
}

export function readPersistedRawArtifact(root: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("raw artifact digest is invalid");
  assertSemanticArtifactRoot(root);
  const raw = readRootBoundCanonicalUtf8Artifact({
    root,
    directorySegments: ["raw", digest.slice(0, 2)],
    filename: `${digest}.json`,
    maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
    label: `raw artifact ${digest}`
  });
  if (createHash("sha256").update(raw, "utf8").digest("hex") !== digest) {
    throw new Error("raw artifact digest mismatch");
  }
  return raw;
}

export function reserveSemanticArtifact(
  root: string,
  semanticKey: string,
  capability: string,
  lease?: ExtractionCacheWriteLease
): string {
  ensureSemanticArtifactRoot(root);
  return createSemanticArtifactReservation(root, semanticKey, capability, lease);
}

export function admitSemanticArtifact(input: {
  readonly root: string;
  readonly admission: VerifiedSemanticArtifactAdmission;
  readonly reservationToken: string;
  readonly expectedIdentity: SemanticAdmissionIdentity;
}): void {
  const artifact = parseSemanticArtifact(unwrapVerifiedSemanticArtifactAdmission(input.admission));
  assertSemanticArtifactCompatibility(input.expectedIdentity, artifact);
  resolveExtractionCapability(artifact.capability);
  if (artifact.admission_state === "provider_backed") {
    if (artifact.raw_response_digest === undefined) throw new Error("provider artifact lost raw digest");
    readPersistedRawArtifact(input.root, artifact.raw_response_digest);
  }
  withArtifactDirectory(
    input.root, artifact.semantic_key, artifact.capability, artifact.replay_identity_digest,
    (directory, filename, stableRoot) => {
      withRootBoundDirectory({
        root: stableRoot, segments: [".tmp"], label: "semantic artifact temporary root"
      }, (temporaryDirectory) => {
        publishBytesExclusiveDurable({
          destination: `${directory}/${filename}`,
          bytes: Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8"),
          ownerIdentity: input.reservationToken,
          temporaryDirectory
        });
      });
      consumeSemanticArtifactReservation(directory, filename, input.reservationToken);
    }
  );
  writeArtifactBindings(
    input.root, artifact.semantic_key, artifact.capability, artifact.source_bindings
  );
}

export function inspectSemanticArtifact(
  root: string,
  semanticKey: string,
  capability: string
): SemanticArtifactInspectResult {
  assertSemanticPathIdentity(semanticKey, capability);
  if (!boundedArtifactEntryExists(join(root, "ROOT_KIND"))) return { status: "missing" };
  try {
    return withArtifactDirectory(root, semanticKey, capability, undefined,
      (directory, filename) => {
        if (!entryExists(directory, filename)) {
          return entryExists(directory, `${filename}.reserve`)
            ? { status: "reserved" } : { status: "missing" };
        }
        return inspectArtifactFile(
          root, `${directory}/${filename}`, semanticKey, capability,
          parseArtifactFilename(filename)?.replayIdentityDigest
        );
      });
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return { status: "missing" };
    return { status: "invalid", reason: errorMessage(cause) };
  }
}

export function listSemanticArtifactInventory(root: string): readonly SemanticArtifact[] {
  return listPersistedSemanticArtifacts(root).filter(isAvailableSemanticArtifact);
}

export function findRawBackedDerivedArtifacts(
  root: string,
  semanticKey: string,
  capability: string
): readonly SemanticArtifact[] {
  assertSemanticPathIdentity(semanticKey, capability);
  return listPersistedSemanticArtifacts(root).filter((artifact) =>
    artifact.semantic_key === semanticKey &&
    artifact.capability === capability &&
    artifact.raw_response_digest !== undefined &&
    (artifact.admission_state === "provider_backed" ||
      artifact.admission_state === "quarantined"));
}

export function digestSemanticOverlay(root: string): string {
  return withRootBoundDirectory({ root, label: "semantic overlay digest" }, (stableRoot) => {
    const artifacts = listSemanticArtifactInventory(stableRoot);
    if (artifacts.length === 0) throw new Error("semantic overlay has no available artifacts");
    return digestSemanticOverlayArtifacts(stableRoot, artifacts);
  });
}

export function digestSemanticOverlayState(root: string): string {
  return withRootBoundDirectory({ root, label: "semantic overlay state" }, (stableRoot) =>
    digestSemanticOverlayArtifacts(stableRoot, listSemanticArtifactInventory(stableRoot)));
}

export function digestSemanticCacheState(root: string): string {
  assertSemanticArtifactRoot(root);
  recoverMalformedSemanticReservations(root);
  const rows: string[] = [];
  try {
    withRootBoundDirectory({ root, label: "semantic cache inventory" }, (stableRoot) => {
      collectArtifactInventory(stableRoot, rows);
      collectRawInventory(stableRoot, rows);
    });
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
  return createHash("sha256").update(rows.sort().join("\n"), "utf8").digest("hex");
}

function listPersistedSemanticArtifacts(root: string): readonly SemanticArtifact[] {
  assertSemanticArtifactRoot(root);
  const artifacts: SemanticArtifact[] = [];
  forEachArtifactEntry(root, (semanticKey, capability, replayIdentityDigest, stableRoot) => {
    const inspected = inspectArtifactAt(
      stableRoot, semanticKey, capability, replayIdentityDigest
    );
    if (inspected.artifact !== undefined) artifacts.push(inspected.artifact);
  });
  return artifacts;
}

function inspectArtifactAt(
  root: string,
  semanticKey: string,
  capability: string,
  replayIdentityDigest: string
): SemanticArtifactInspectResult {
  return withArtifactDirectory(root, semanticKey, capability, replayIdentityDigest,
    (directory, filename) => {
      if (!entryExists(directory, filename)) return { status: "missing" };
      return inspectArtifactFile(
        root, `${directory}/${filename}`, semanticKey, capability, replayIdentityDigest
      );
    });
}

function digestSemanticOverlayArtifacts(
  root: string,
  artifacts: readonly SemanticArtifact[]
): string {
  return createHash("sha256").update(artifacts.map((artifact) => {
    const bindings = recordedSourceBindings(root, artifact.semantic_key, artifact.capability);
    return `${artifact.semantic_key}:${artifact.capability}:${artifact.artifact_digest}:` +
      digestBindingSet(bindings);
  }).sort().join("\n"), "utf8").digest("hex");
}

function inspectArtifactFile(
  root: string,
  path: string,
  semanticKey: string,
  capability: string,
  replayIdentityDigest: string | undefined
): SemanticArtifactInspectResult {
  try {
    const serialized = readBoundedCanonicalUtf8Artifact({
      path, maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES, label: `semantic artifact ${semanticKey}`
    });
    const artifact = parseSemanticArtifact(JSON.parse(serialized) as unknown);
    if (artifact.semantic_key !== semanticKey || artifact.capability !== capability) {
      return { status: "invalid", reason: "path identity mismatch" };
    }
    if (replayIdentityDigest !== undefined &&
        artifact.replay_identity_digest !== replayIdentityDigest) {
      return { status: "invalid", reason: "derived replay path identity mismatch" };
    }
    if (artifact.admission_state === "provider_backed") {
      if (artifact.raw_response_digest === undefined) {
        return { status: "invalid", artifact, reason: "provider artifact lost raw digest" };
      }
      readPersistedRawArtifact(root, artifact.raw_response_digest);
    }
    if (artifact.admission_state === "invalid") {
      return { status: "invalid", artifact, reason: "admitted invalid" };
    }
    if (artifact.admission_state === "quarantined") {
      return { status: "quarantined", artifact, reason: artifact.quarantine_reason };
    }
    return { status: artifact.admission_state, artifact };
  } catch (cause) {
    return { status: "invalid", reason: errorMessage(cause) };
  }
}

function forEachArtifactEntry(
  root: string,
  visit: (
    semanticKey: string,
    capability: string,
    replayIdentityDigest: string,
    stableRoot: string
  ) => void
): void {
  try {
    withRootBoundDirectory({ root, label: "semantic artifact inventory" }, (stableRoot) => {
      for (const shard of readdirSync(stableRoot, { withFileTypes: true })) {
        if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(shard.name)) continue;
        withRootBoundDirectory({
          root: stableRoot, segments: [shard.name], label: "semantic artifact shard"
        }, (directory) => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const parsed = parseArtifactFilename(entry.name);
            if (entry.isFile() && !entry.isSymbolicLink() && parsed !== undefined) {
              visit(parsed.semanticKey, parsed.capability, parsed.replayIdentityDigest, stableRoot);
            }
          }
        });
      }
    });
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
}

function withArtifactDirectory<T>(
  root: string,
  semanticKey: string,
  capability: string,
  replayIdentityDigest: string | undefined,
  operation: (directory: string, filename: string, stableRoot: string) => T
): T {
  assertSemanticArtifactRoot(root);
  assertSemanticPathIdentity(semanticKey, capability);
  const filename = artifactFilename(semanticKey, capability, replayIdentityDigest);
  return withRootBoundDirectory({
    root,
    segments: [artifactPrefix(semanticKey)],
    label: "semantic artifact shard"
  }, (directory, stableRoot) => operation(directory, filename, stableRoot));
}

function withPublicationDirectories(
  root: string,
  segments: readonly string[],
  label: string,
  operation: (directory: string, temporaryDirectory: string) => void
): void {
  withRootBoundDirectory({ root, segments, createSegments: true, label }, (directory, stableRoot) => {
    withRootBoundDirectory({
      root: stableRoot, segments: [".tmp"], createSegments: true, label
    }, (temporary) => {
      operation(directory, temporary);
    });
  });
}

function collectArtifactInventory(stableRoot: string, rows: string[]): void {
  for (const shard of readdirSync(stableRoot, { withFileTypes: true })) {
    if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(shard.name)) continue;
    withRootBoundDirectory({
      root: stableRoot, segments: [shard.name], label: "semantic cache inventory shard"
    }, (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.name.endsWith(".json") && !entry.name.endsWith(".json.reserve")) continue;
        const serialized = readBoundedCanonicalUtf8Artifact({
          path: `${directory}/${entry.name}`,
          maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
          label: "semantic cache inventory entry"
        });
        if (entry.name.endsWith(".reserve")) {
          assertValidReserveInventory(directory, entry.name);
        } else {
          assertValidArtifactInventory(stableRoot, entry.name, serialized);
        }
        const identity = createHash("sha256").update(serialized, "utf8").digest("hex");
        rows.push(`${shard.name}/${entry.name}:${identity}:${Buffer.byteLength(serialized, "utf8")}`);
      }
    });
  }
}

function assertValidReserveInventory(directory: string, filename: string): void {
  const descriptor = openSync(
    `${directory}/${filename}`, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG
  );
  try {
    if (readReserveOwnerFromFd(descriptor) === undefined) {
      throw new Error("semantic cache inventory contains a corrupt reservation");
    }
  } finally {
    closeSync(descriptor);
  }
}

function assertValidArtifactInventory(
  stableRoot: string,
  filename: string,
  serialized: string
): void {
  const artifact = parseSemanticArtifact(JSON.parse(serialized));
  const parsedPath = parseArtifactFilename(filename);
  if (parsedPath === undefined || artifact.semantic_key !== parsedPath.semanticKey ||
      artifact.capability !== parsedPath.capability ||
      artifact.replay_identity_digest !== parsedPath.replayIdentityDigest) {
    throw new Error("semantic cache inventory artifact path identity mismatch");
  }
  if (artifact.admission_state === "provider_backed") {
    if (artifact.raw_response_digest === undefined) {
      throw new Error("semantic cache inventory provider artifact lost raw digest");
    }
    readPersistedRawArtifact(stableRoot, artifact.raw_response_digest);
  }
}

function collectRawInventory(stableRoot: string, rows: string[]): void {
  try {
    withRootBoundDirectory({ root: stableRoot, segments: ["raw"], label: "raw artifact inventory" },
      (rawRoot) => {
        for (const shard of readdirSync(rawRoot, { withFileTypes: true })) {
          if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(shard.name)) {
            throw new Error("raw artifact inventory contains a foreign entry");
          }
          withRootBoundDirectory({
            root: rawRoot, segments: [shard.name], label: "raw artifact inventory shard"
          }, (directory) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
              const match = /^([a-f0-9]{64})\.json$/u.exec(entry.name);
              if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
                throw new Error("raw artifact inventory contains a foreign entry");
              }
              const identity = readBoundedStableRegularFile({
                path: `${directory}/${entry.name}`,
                maxBytes: SEMANTIC_ARTIFACT_MAX_BYTES,
                label: "raw artifact inventory entry"
              }).identity;
              if (identity.sha256 !== match[1]) throw new Error("raw artifact inventory digest mismatch");
              rows.push(`raw/${shard.name}/${entry.name}:${identity.sha256}:${identity.byteLength}`);
            }
          });
        }
      });
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
}

function entryExists(directory: string, filename: string): boolean {
  return boundedArtifactEntryExists(`${directory}/${filename}`);
}

function assertSemanticArtifactRoot(root: string): void {
  const marker = readRootBoundCanonicalUtf8Artifact({
    root,
    filename: "ROOT_KIND",
    maxBytes: Buffer.byteLength(`${SEMANTIC_ARTIFACT_ROOT_KIND}\n`, "utf8"),
    label: "semantic artifact root kind"
  });
  if (marker !== `${SEMANTIC_ARTIFACT_ROOT_KIND}\n`) {
    throw new Error("semantic artifact root has a foreign ROOT_KIND marker");
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
