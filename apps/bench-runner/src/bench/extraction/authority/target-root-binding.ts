import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtractionCacheWriteLease } from "../fill/manifest/fill-root-guard.js";
import { readBoundedStableRegularFile } from
  "../cache-audit/bounded-artifact-reader.js";

const MAX_TARGET_ROOT_MARKER_BYTES = 16 * 1024;

export interface ExtractionTargetRootMarker {
  readonly filename: string;
  readonly kind: string;
}

export interface ExtractionTargetRootBinding {
  readonly cache_root_sha256: string;
  readonly cache_root_device: string;
  readonly cache_root_inode: string;
  readonly cache_root_marker_sha256: string;
}

export function assertFreshExtractionTargetRootPath(cacheRoot: string): void {
  const root = resolve(cacheRoot);
  if (existsSync(root)) {
    throw new Error("extraction target root must not exist before creation");
  }
  const parent = resolve(root, "..");
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new Error("extraction target root parent must not be a symlink");
  }
}

interface TargetRootInput {
  readonly cacheRoot: string;
  readonly marker: ExtractionTargetRootMarker;
  readonly purpose: string;
}

export function createFreshExtractionTargetRoot(
  input: TargetRootInput
): ExtractionTargetRootBinding {
  const root = canonicalExtractionTargetRoot(input.cacheRoot);
  const identity = createFreshRoot(root, input.marker, input.purpose);
  return Object.freeze({
    cache_root_sha256: hashRoot(root),
    cache_root_device: identity.device,
    cache_root_inode: identity.inode,
    cache_root_marker_sha256: identity.markerSha256
  });
}

export function assertExtractionTargetRootBinding(input: TargetRootInput & {
  readonly binding: ExtractionTargetRootBinding;
  /** The active writer lease may prove the root still belongs to this fill. */
  readonly writeLease?: ExtractionCacheWriteLease;
}): void {
  const root = canonicalExtractionTargetRoot(input.cacheRoot);
  try {
    assertTargetRootWriteLease(root, input.writeLease);
    if (!hasRuntimeTargetRootBinding(root, input.marker, input.binding)) {
      throw new Error("binding mismatch");
    }
  } catch {
    throw new Error(`${input.purpose} target root changed`);
  }
}

export function discardFreshExtractionTargetRoot(input: TargetRootInput & {
  readonly binding: ExtractionTargetRootBinding;
}): void {
  try {
    const root = canonicalExtractionTargetRoot(input.cacheRoot);
    if (!hasUnchangedFreshTargetRoot(root, input.marker, input.binding)) return;
    if (!hasOnlyMarker(root, input.marker)) return;
    const markerPath = markerPathFor(root, input.marker);
    const markerBytes = readMarkerBytes(markerPath);
    unlinkSync(markerPath);
    try {
      rmdirSync(root);
    } catch {
      restoreMarker(root, input.marker, input.binding, markerBytes);
    }
  } catch {
    // A failed preflight must never remove a root that acquired content or changed identity.
  }
}

function hasRuntimeTargetRootBinding(
  root: string,
  marker: ExtractionTargetRootMarker,
  binding: ExtractionTargetRootBinding
): boolean {
  const stat = lstatSync(root, { bigint: true });
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    hashRoot(root) === binding.cache_root_sha256 &&
    readMarkerSha256(root, marker) === binding.cache_root_marker_sha256 &&
    stat.dev.toString() === binding.cache_root_device &&
    stat.ino.toString() === binding.cache_root_inode;
}

function assertTargetRootWriteLease(
  root: string,
  writeLease: ExtractionCacheWriteLease | undefined
): void {
  if (writeLease === undefined) return;
  writeLease.assertOwned();
  if (canonicalExtractionTargetRoot(writeLease.cacheRoot) !== root) {
    throw new Error("write lease does not bind the selected target root");
  }
}

function hasUnchangedFreshTargetRoot(
  root: string,
  marker: ExtractionTargetRootMarker,
  binding: ExtractionTargetRootBinding
): boolean {
  const stat = lstatSync(root, { bigint: true });
  return hasRuntimeTargetRootBinding(root, marker, binding) &&
    stat.dev.toString() === binding.cache_root_device &&
    stat.ino.toString() === binding.cache_root_inode;
}

export function canonicalExtractionTargetRoot(cacheRoot: string): string {
  const absolute = resolve(cacheRoot);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

function createFreshRoot(
  root: string,
  marker: ExtractionTargetRootMarker,
  purpose: string
): { readonly device: string; readonly inode: string; readonly markerSha256: string } {
  try {
    mkdirSync(root);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${purpose} target root must be new: ${detail}`);
  }
  let identity: { readonly device: string; readonly inode: string } | undefined;
  try {
    const stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${purpose} target root is not a real directory`);
    }
    identity = Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() });
    return Object.freeze({ ...identity, markerSha256: writeMarker(root, marker) });
  } catch (cause) {
    discardEmptyUninitializedRoot(root, identity);
    throw cause;
  }
}

function writeMarker(root: string, marker: ExtractionTargetRootMarker): string {
  const bytes = Buffer.from(`${JSON.stringify({ kind: marker.kind, root_id: randomUUID() })}\n`, "utf8");
  writeFileSync(markerPathFor(root, marker), bytes, { flag: "wx" });
  return hashBytes(bytes);
}

function readMarkerSha256(root: string, marker: ExtractionTargetRootMarker): string {
  const path = markerPathFor(root, marker);
  return hashBytes(readMarkerBytes(path));
}

function readMarkerBytes(path: string): Buffer {
  return readBoundedStableRegularFile({
    path,
    maxBytes: MAX_TARGET_ROOT_MARKER_BYTES,
    label: "extraction target root marker"
  }).bytes;
}

function markerPathFor(root: string, marker: ExtractionTargetRootMarker): string {
  return join(root, marker.filename);
}

function hasOnlyMarker(root: string, marker: ExtractionTargetRootMarker): boolean {
  const entries = readdirSync(root);
  return entries.length === 1 && entries[0] === marker.filename;
}

function discardEmptyUninitializedRoot(
  root: string,
  identity: { readonly device: string; readonly inode: string } | undefined
): void {
  try {
    if (identity !== undefined) {
      const stat = lstatSync(root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          stat.dev.toString() !== identity.device || stat.ino.toString() !== identity.inode) return;
    }
    rmdirSync(root);
  } catch {
    // Initialization may race with content, so cleanup is intentionally non-recursive.
  }
}

function restoreMarker(
  root: string,
  marker: ExtractionTargetRootMarker,
  binding: ExtractionTargetRootBinding,
  markerBytes: Uint8Array
): void {
  try {
    const stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        stat.dev.toString() !== binding.cache_root_device ||
        stat.ino.toString() !== binding.cache_root_inode) return;
    writeFileSync(markerPathFor(root, marker), markerBytes, { flag: "wx" });
  } catch {
    // The root changed after marker removal, so it must remain untouched.
  }
}

function hashRoot(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
