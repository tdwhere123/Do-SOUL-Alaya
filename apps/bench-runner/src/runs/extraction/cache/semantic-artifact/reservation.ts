import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import {
  boundedArtifactEntryExists,
  withRootBoundDirectory
} from "../../cache-audit/bounded-artifact-reader.js";
import type { ExtractionCacheWriteLease } from
  "../../fill/manifest/fill-root-guard.js";
import { readProcessStartIdentity } from
  "../../fill/manifest/writer-lock.js";
import {
  artifactFilename,
  artifactPrefix,
  parseArtifactFilename
} from "./derived-path.js";
import { NO_FOLLOW_OPEN_FLAG } from "../../../fs/open-flags.js";
import { openHeldReserveDescriptor } from "./reservation-fd.js";

interface ReserveOwner {
  readonly token: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly writerGeneration?: string;
}

export function createSemanticArtifactReservation(
  root: string,
  semanticKey: string,
  capability: string,
  lease?: ExtractionCacheWriteLease
): string {
  if (lease !== undefined) {
    lease.assertOwned();
    lease.assertRoot(root);
  }
  const filename = artifactFilename(semanticKey, capability);
  return withRootBoundDirectory({
    root, segments: [artifactPrefix(semanticKey)], createSegments: true,
    label: "semantic artifact reservation"
  }, (directory) => {
    if (boundedArtifactEntryExists(`${directory}/${filename}`)) {
      throw new Error("semantic artifact already admitted");
    }
    const token = randomUUID();
    writeExclusiveReserveFile(directory, `${filename}.reserve`, {
      schema_version: lease === undefined ? 1 : 2,
      token,
      pid: process.pid,
      process_start_identity: readProcessStartIdentity(process.pid),
      ...(lease === undefined ? {} : { writer_generation: lease.generation })
    });
    return token;
  });
}

export function reclaimAbandonedReservation(
  root: string,
  semanticKey: string,
  capability: string,
  lease: ExtractionCacheWriteLease
): void {
  lease.assertOwned();
  lease.assertRoot(root);
  const filename = artifactFilename(semanticKey, capability);
  withRootBoundDirectory({
    root, segments: [artifactPrefix(semanticKey)], label: "semantic artifact shard"
  }, (directory) => {
    if (boundedArtifactEntryExists(`${directory}/${filename}`)) return;
    withHeldReserveFile(directory, `${filename}.reserve`, (descriptor, boundPath) => {
      const owner = readReserveOwnerFromFd(descriptor);
      if (owner === undefined) {
        unlinkHeldReserve(descriptor, boundPath, directory);
        return;
      }
      if (owner.writerGeneration !== undefined) {
        if (owner.writerGeneration === lease.generation) return;
        unlinkHeldReserve(descriptor, boundPath, directory);
        return;
      }
      if (processAlive(owner.pid, owner.processStartIdentity)) return;
      unlinkHeldReserve(descriptor, boundPath, directory);
    }, false);
  });
}

export function releaseSemanticArtifactReservation(
  root: string,
  semanticKey: string,
  capability: string,
  token: string
): void {
  const filename = artifactFilename(semanticKey, capability);
  withRootBoundDirectory({
    root, segments: [artifactPrefix(semanticKey)], label: "semantic artifact shard"
  }, (directory) => {
    withHeldReserveFile(directory, `${filename}.reserve`, (descriptor, boundPath) => {
      if (readReserveOwnerFromFd(descriptor)?.token !== token) {
        throw new Error("semantic artifact reservation token mismatch");
      }
      unlinkHeldReserve(descriptor, boundPath, directory);
    }, true);
  });
}

export function consumeSemanticArtifactReservation(
  directory: string,
  filename: string,
  token: string
): void {
  withHeldReserveFile(directory, `${filename}.reserve`, (descriptor, boundPath) => {
    if (readReserveOwnerFromFd(descriptor)?.token !== token) {
      throw new Error("semantic artifact reservation token mismatch");
    }
    unlinkHeldReserve(descriptor, boundPath, directory);
  }, true);
}

export function recoverMalformedSemanticReservations(root: string): void {
  withRootBoundDirectory({ root, label: "semantic reservation recovery" }, (stableRoot) => {
    for (const shard of readdirSync(stableRoot, { withFileTypes: true })) {
      if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[a-f0-9]{2}$/u.test(shard.name)) {
        continue;
      }
      withRootBoundDirectory({
        root: stableRoot, segments: [shard.name], label: "semantic reservation recovery shard"
      }, (directory) => recoverMalformedInDirectory(directory));
    }
  });
}

export function readReserveOwnerFromFd(descriptor: number): ReserveOwner | undefined {
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.size > 512n) return undefined;
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return undefined;
      offset += count;
    }
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (Buffer.from(decoded, "utf8").equals(bytes) === false) return undefined;
    return parseReserveOwner(JSON.parse(decoded) as unknown);
  } catch {
    return undefined;
  }
}

function recoverMalformedInDirectory(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json.reserve")) continue;
    const artifactName = entry.name.slice(0, -".reserve".length);
    if (parseArtifactFilename(artifactName) === undefined) {
      withHeldReserveFile(directory, entry.name, (descriptor, boundPath) => {
        unlinkHeldReserve(descriptor, boundPath, directory);
      }, false);
      continue;
    }
    withHeldReserveFile(directory, entry.name, (descriptor, boundPath) => {
      if (readReserveOwnerFromFd(descriptor) === undefined) {
        unlinkHeldReserve(descriptor, boundPath, directory);
      }
    }, false);
  }
}

function writeExclusiveReserveFile(
  directory: string,
  filename: string,
  owner: Record<string, unknown>
): void {
  const boundPath = `${directory}/${filename}`;
  let descriptor: number;
  try {
    descriptor = openSync(
      boundPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_OPEN_FLAG,
      0o600
    );
  } catch (cause) {
    throw new Error("semantic artifact reservation is held", { cause });
  }
  try {
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written === 0) throw new Error("semantic artifact reservation write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
  } catch (cause) {
    try {
      unlinkHeldReserve(descriptor, boundPath, directory);
    } catch {
      // Held inode drops on close; a swapped name must not be unlinked.
    }
    try {
      closeSync(descriptor);
    } catch {
      // Descriptor may already be closed after a failed create.
    }
    throw new Error("semantic artifact reservation is held", { cause });
  }
  closeSync(descriptor);
}

function withHeldReserveFile(
  directory: string,
  filename: string,
  operation: (descriptor: number, boundPath: string) => void,
  required: boolean
): void {
  const boundPath = `${directory}/${filename}`;
  let descriptor: number;
  try {
    descriptor = openHeldReserveDescriptor(boundPath);
  } catch (cause) {
    if (!required && hasCode(cause, "ENOENT")) return;
    if (hasCode(cause, "ELOOP") || hasCode(cause, "EMLINK")) {
      unlinkSymlinkName(boundPath, directory);
      if (required) throw new Error("semantic artifact reservation is not a regular file", { cause });
      return;
    }
    if (required) throw new Error("semantic artifact reservation token mismatch", { cause });
    throw cause;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) {
      throw new Error("semantic artifact reservation is not a regular file");
    }
    operation(descriptor, boundPath);
  } finally {
    closeSync(descriptor);
  }
}

function unlinkHeldReserve(descriptor: number, boundPath: string, directory: string): void {
  const held = fstatSync(descriptor, { bigint: true });
  if (!held.isFile() || held.nlink !== 1n) {
    throw new Error("semantic artifact reservation is not a uniquely linked regular file");
  }
  const trash = `${directory}/.reserve-release-${held.ino.toString()}-${randomUUID()}`;
  renameSync(boundPath, trash);
  const named = lstatSync(trash, { bigint: true });
  if (named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino) {
    try {
      renameSync(trash, boundPath);
    } catch {
      // A swapped inode must be restored rather than unlinked.
    }
    throw new Error("semantic artifact reservation name was replaced before release");
  }
  unlinkSync(trash);
  const after = fstatSync(descriptor, { bigint: true });
  if (after.nlink !== 0n) {
    throw new Error("semantic artifact reservation unlink did not remove the held inode");
  }
}

function unlinkSymlinkName(boundPath: string, directory: string): void {
  const trash = `${directory}/.reserve-release-symlink-${randomUUID()}`;
  try {
    renameSync(boundPath, trash);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return;
    throw cause;
  }
  const named = lstatSync(trash, { bigint: true });
  if (!named.isSymbolicLink()) {
    try {
      renameSync(trash, boundPath);
    } catch {
      // A swapped inode must be restored rather than unlinked.
    }
    throw new Error("semantic artifact reservation name was replaced before release");
  }
  unlinkSync(trash);
}

function parseReserveOwner(value: unknown): ReserveOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  if ((owner.schema_version !== 1 && owner.schema_version !== 2) ||
      typeof owner.token !== "string" || owner.token.length === 0 ||
      !Number.isInteger(owner.pid) || Number(owner.pid) <= 0 ||
      typeof owner.process_start_identity !== "string" || owner.process_start_identity.length === 0 ||
      (owner.schema_version === 2 &&
        (typeof owner.writer_generation !== "string" || owner.writer_generation.length === 0))) {
    return undefined;
  }
  return {
    token: owner.token,
    pid: Number(owner.pid),
    processStartIdentity: owner.process_start_identity,
    ...(owner.schema_version === 2
      ? { writerGeneration: owner.writer_generation as string }
      : {})
  };
}

function processAlive(pid: number, expectedStartIdentity: string): boolean {
  try {
    process.kill(pid, 0);
    return readProcessStartIdentity(pid) === expectedStartIdentity;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}
