import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";

export const C0_EXTRACTION_LOCK_DIR = ".extraction-fill.lock";
export const C0_LOCK_PREPARED_JOURNAL = ".c0-lock-isolation-prepared.json";
export const C0_LOCK_RELOCATION_RECEIPT = ".c0-lock-isolation-receipt.json";

export type C0LockNodeKind = "directory" | "file" | "symlink" | "other";

export interface C0LockNodeStat {
  readonly kind: C0LockNodeKind;
  readonly device: number;
  readonly size: number;
}

export interface C0LockFilesystem {
  canonicalPath(path: string): string;
  lstat(path: string): C0LockNodeStat;
  lstatIfPresent(path: string): C0LockNodeStat | undefined;
  readDirectory(path: string): readonly string[];
  readFile(path: string): Uint8Array;
  writeNewFile(path: string, contents: string): void;
  rename(source: string, target: string): void;
}

export interface C0LockOwnerSummary {
  readonly sha256: string;
  readonly byte_length: number;
  readonly parse_status: "parsed" | "unparsed";
  readonly pid?: number;
  readonly started_at?: string;
  readonly token_present: boolean;
}

export interface C0StoppedOwnerProof {
  readonly status: "stopped";
  /** Distinguishes an observed local process exit from an operator's attestation. */
  readonly basis: "same_host_observation" | "operator_attestation";
  readonly source_owner_sha256: string;
  readonly source_pid: number;
  readonly observed_at: string;
}

export interface C0LockRelocationInput {
  readonly sourceCacheRoot: string;
  readonly targetEvidenceRoot: string;
  readonly filesystem: C0LockFilesystem;
  readonly now: () => string;
  readonly proveStoppedOwner?: (
    owner: C0LockOwnerSummary
  ) => C0StoppedOwnerProof | undefined;
}

export interface C0LockTreeDigest {
  readonly sha256: string;
  readonly entry_count: number;
  readonly byte_length: number;
}

export interface C0LockInspection {
  readonly source_cache_root: string;
  readonly target_evidence_root: string;
  readonly source_lock_path: string;
  readonly target_lock_path: string;
  readonly prepared_journal_path: string;
  readonly receipt_path: string;
  readonly device: number;
  readonly owner: C0LockOwnerSummary;
  readonly stopped_owner_proof: C0StoppedOwnerProof;
  readonly tree: C0LockTreeDigest;
}

export interface C0LockRelocationReceipt {
  readonly schema_version: 1;
  readonly outcome: "relocated";
  readonly moved_at: string;
  readonly source_cache_root: string;
  readonly target_evidence_root: string;
  readonly source_lock_path: string;
  readonly target_lock_path: string;
  readonly device: number;
  readonly owner: C0LockOwnerSummary;
  readonly stopped_owner_proof: C0StoppedOwnerProof;
  readonly pre_tree_sha256: string;
  readonly post_tree_sha256: string;
  readonly tree_entry_count: number;
  readonly tree_byte_length: number;
}

export class C0LockIsolationError extends Error {
  override readonly name = "C0LockIsolationError";
}

interface C0LockRoots {
  readonly source: string;
  readonly target: string;
}

interface TreeAccumulator {
  entryCount: number;
  byteLength: number;
}

export function inspectC0LockRelocation(
  input: C0LockRelocationInput
): C0LockInspection {
  const roots = inspectRoots(input);
  const sourceLock = join(roots.source, C0_EXTRACTION_LOCK_DIR);
  const targetLock = join(roots.target, C0_EXTRACTION_LOCK_DIR);
  const preparedJournalPath = join(roots.target, C0_LOCK_PREPARED_JOURNAL);
  const receiptPath = join(roots.target, C0_LOCK_RELOCATION_RECEIPT);
  const sourceStat = assertDirectory(input.filesystem, sourceLock, "source lock");
  const owner = readOwnerSummary(input.filesystem, sourceLock);
  const proof = assertStoppedOwnerProof(input, owner);
  const tree = digestLockTree(input.filesystem, sourceLock);
  assertDestinationClear(input.filesystem, targetLock);
  assertEvidenceArtifactsClear(input.filesystem, preparedJournalPath, receiptPath);
  assertSameDevice(sourceStat, input.filesystem, roots.target);
  return {
    source_cache_root: roots.source,
    target_evidence_root: roots.target,
    source_lock_path: sourceLock,
    target_lock_path: targetLock,
    prepared_journal_path: preparedJournalPath,
    receipt_path: receiptPath,
    device: sourceStat.device,
    owner,
    stopped_owner_proof: proof,
    tree
  };
}

export function relocateC0Lock(
  input: C0LockRelocationInput
): C0LockRelocationReceipt {
  const inspection = inspectC0LockRelocation(input);
  writePreparedJournal(input, inspection);
  revalidateBeforeRename(input, inspection);
  input.filesystem.rename(inspection.source_lock_path, inspection.target_lock_path);
  return validateAndRecordRelocation(input, inspection);
}

function inspectRoots(input: C0LockRelocationInput): C0LockRoots {
  const filesystem = input.filesystem;
  assertDirectory(filesystem, input.sourceCacheRoot, "source cache root");
  assertDirectory(filesystem, input.targetEvidenceRoot, "target evidence root");
  const source = filesystem.canonicalPath(input.sourceCacheRoot);
  const target = filesystem.canonicalPath(input.targetEvidenceRoot);
  assertDirectory(filesystem, source, "canonical source cache root");
  assertDirectory(filesystem, target, "canonical target evidence root");
  if (pathsOverlap(source, target)) {
    throw new C0LockIsolationError("source cache root and target evidence root must not overlap");
  }
  return { source, target };
}

function assertDirectory(
  filesystem: C0LockFilesystem,
  path: string,
  label: string
): C0LockNodeStat {
  const stat = filesystem.lstat(path);
  if (stat.kind === "symlink") {
    throw new C0LockIsolationError(`${label} must not be a symbolic link`);
  }
  if (stat.kind !== "directory") {
    throw new C0LockIsolationError(`${label} must be a directory`);
  }
  return stat;
}

function pathsOverlap(source: string, target: string): boolean {
  return isNestedPath(source, target) || isNestedPath(target, source);
}

function isNestedPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function readOwnerSummary(
  filesystem: C0LockFilesystem,
  lockPath: string
): C0LockOwnerSummary {
  const ownerPath = join(lockPath, "owner.json");
  const stat = filesystem.lstat(ownerPath);
  if (stat.kind !== "file") throw new C0LockIsolationError("lock owner receipt must be a regular file");
  const bytes = filesystem.readFile(ownerPath);
  return summarizeOwnerBytes(bytes);
}

function summarizeOwnerBytes(bytes: Uint8Array): C0LockOwnerSummary {
  const parsed = parseOwnerBytes(bytes);
  return {
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
    parse_status: parsed.parseStatus,
    ...(parsed.pid === undefined ? {} : { pid: parsed.pid }),
    ...(parsed.startedAt === undefined ? {} : { started_at: parsed.startedAt }),
    token_present: parsed.tokenPresent
  };
}

function parseOwnerBytes(bytes: Uint8Array): {
  readonly parseStatus: "parsed" | "unparsed";
  readonly pid?: number;
  readonly startedAt?: string;
  readonly tokenPresent: boolean;
} {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { parseStatus: "unparsed", tokenPresent: false };
    }
    const owner = parsed as Record<string, unknown>;
    return {
      parseStatus: "parsed",
      ...(isPositiveInteger(owner.pid) ? { pid: owner.pid } : {}),
      ...(typeof owner.started_at === "string" ? { startedAt: owner.started_at } : {}),
      tokenPresent: "token" in owner
    };
  } catch {
    return { parseStatus: "unparsed", tokenPresent: false };
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertStoppedOwnerProof(
  input: C0LockRelocationInput,
  owner: C0LockOwnerSummary
): C0StoppedOwnerProof {
  const proof = input.proveStoppedOwner?.(owner);
  if (!isStoppedOwnerProof(proof, owner)) {
    throw new C0LockIsolationError(
      "C0 lock relocation requires an injected stopped-owner proof bound to owner bytes"
    );
  }
  return proof;
}

function isStoppedOwnerProof(
  proof: C0StoppedOwnerProof | undefined,
  owner: C0LockOwnerSummary
): proof is C0StoppedOwnerProof {
  return proof?.status === "stopped" &&
    (proof.basis === "same_host_observation" || proof.basis === "operator_attestation") &&
    proof.source_owner_sha256 === owner.sha256 &&
    proof.source_pid === owner.pid &&
    owner.pid !== undefined && isIsoDate(proof.observed_at);
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function digestLockTree(
  filesystem: C0LockFilesystem,
  lockPath: string
): C0LockTreeDigest {
  const records: string[] = [];
  const totals: TreeAccumulator = { entryCount: 0, byteLength: 0 };
  appendTreeDigestRecords(filesystem, lockPath, ".", records, totals);
  return {
    sha256: sha256(records.join("\n")),
    entry_count: totals.entryCount,
    byte_length: totals.byteLength
  };
}

function appendTreeDigestRecords(
  filesystem: C0LockFilesystem,
  path: string,
  relativePath: string,
  records: string[],
  totals: TreeAccumulator
): void {
  const stat = filesystem.lstat(path);
  if (stat.kind === "symlink") throw new C0LockIsolationError("lock tree must not contain symbolic links");
  if (stat.kind === "file") return appendFileDigestRecord(filesystem, path, relativePath, stat, records, totals);
  if (stat.kind !== "directory") throw new C0LockIsolationError("lock tree contains a non-regular node");
  records.push(`d\t${relativePath}`);
  totals.entryCount += 1;
  for (const name of [...filesystem.readDirectory(path)].sort()) {
    if (!isSafeDirectoryEntry(name)) throw new C0LockIsolationError("lock tree contains an unsafe entry name");
    appendTreeDigestRecords(filesystem, join(path, name), childRelativePath(relativePath, name), records, totals);
  }
}

function appendFileDigestRecord(
  filesystem: C0LockFilesystem,
  path: string,
  relativePath: string,
  stat: C0LockNodeStat,
  records: string[],
  totals: TreeAccumulator
): void {
  const bytes = filesystem.readFile(path);
  if (bytes.byteLength !== stat.size) throw new C0LockIsolationError("lock file changed while hashing");
  records.push(`f\t${relativePath}\t${bytes.byteLength}\t${sha256(bytes)}`);
  totals.entryCount += 1;
  totals.byteLength += bytes.byteLength;
}

function isSafeDirectoryEntry(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." &&
    !/[\\/\t\r\n]/u.test(name);
}

function childRelativePath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function assertDestinationClear(filesystem: C0LockFilesystem, targetLock: string): void {
  if (filesystem.lstatIfPresent(targetLock) !== undefined) {
    throw new C0LockIsolationError("target evidence root already contains an extraction lock");
  }
}

function assertEvidenceArtifactsClear(
  filesystem: C0LockFilesystem,
  preparedJournalPath: string,
  receiptPath: string
): void {
  if (filesystem.lstatIfPresent(preparedJournalPath) !== undefined ||
      filesystem.lstatIfPresent(receiptPath) !== undefined) {
    throw new C0LockIsolationError("target evidence root already contains C0 lock evidence");
  }
}

function assertSameDevice(
  sourceStat: C0LockNodeStat,
  filesystem: C0LockFilesystem,
  targetRoot: string
): void {
  const targetStat = assertDirectory(filesystem, targetRoot, "target evidence root");
  if (sourceStat.device !== targetStat.device) {
    throw new C0LockIsolationError("C0 lock relocation requires a same-device atomic rename");
  }
}

function writePreparedJournal(
  input: C0LockRelocationInput,
  inspection: C0LockInspection
): void {
  input.filesystem.writeNewFile(inspection.prepared_journal_path, serialize({
    schema_version: 1,
    phase: "prepared",
    prepared_at: input.now(),
    ...inspection
  }));
}

function revalidateBeforeRename(
  input: C0LockRelocationInput,
  inspection: C0LockInspection
): void {
  assertStableRoots(input, inspection);
  const sourceStat = assertDirectory(input.filesystem, inspection.source_lock_path, "source lock");
  assertDestinationClear(input.filesystem, inspection.target_lock_path);
  if (input.filesystem.lstatIfPresent(inspection.receipt_path) !== undefined) {
    throw new C0LockIsolationError("C0 lock receipt appeared before relocation");
  }
  assertSameDevice(sourceStat, input.filesystem, inspection.target_evidence_root);
  assertStableOwner(input.filesystem, inspection);
  assertStableTree(input.filesystem, inspection);
}

function assertStableRoots(input: C0LockRelocationInput, inspection: C0LockInspection): void {
  const roots = inspectRoots(input);
  if (roots.source !== inspection.source_cache_root || roots.target !== inspection.target_evidence_root) {
    throw new C0LockIsolationError("canonical lock roots changed before relocation");
  }
}

function assertStableOwner(filesystem: C0LockFilesystem, inspection: C0LockInspection): void {
  if (readOwnerSummary(filesystem, inspection.source_lock_path).sha256 !== inspection.owner.sha256) {
    throw new C0LockIsolationError("lock owner bytes changed before relocation");
  }
}

function assertStableTree(filesystem: C0LockFilesystem, inspection: C0LockInspection): void {
  if (digestLockTree(filesystem, inspection.source_lock_path).sha256 !== inspection.tree.sha256) {
    throw new C0LockIsolationError("lock tree changed before relocation");
  }
}

function validateAndRecordRelocation(
  input: C0LockRelocationInput,
  inspection: C0LockInspection
): C0LockRelocationReceipt {
  if (input.filesystem.lstatIfPresent(inspection.source_lock_path) !== undefined) {
    throw new C0LockIsolationError("source lock remains after atomic relocation");
  }
  const targetStat = assertDirectory(input.filesystem, inspection.target_lock_path, "relocated lock");
  if (targetStat.device !== inspection.device) {
    throw new C0LockIsolationError("relocated lock changed devices");
  }
  const owner = readOwnerSummary(input.filesystem, inspection.target_lock_path);
  if (owner.sha256 !== inspection.owner.sha256) {
    throw new C0LockIsolationError("relocated lock owner bytes changed");
  }
  const tree = digestLockTree(input.filesystem, inspection.target_lock_path);
  if (tree.sha256 !== inspection.tree.sha256) {
    throw new C0LockIsolationError("relocated lock tree hash changed");
  }
  const receipt = buildReceipt(input, inspection, tree);
  input.filesystem.writeNewFile(inspection.receipt_path, serialize(receipt));
  return receipt;
}

function buildReceipt(
  input: C0LockRelocationInput,
  inspection: C0LockInspection,
  tree: C0LockTreeDigest
): C0LockRelocationReceipt {
  return {
    schema_version: 1,
    outcome: "relocated",
    moved_at: input.now(),
    source_cache_root: inspection.source_cache_root,
    target_evidence_root: inspection.target_evidence_root,
    source_lock_path: inspection.source_lock_path,
    target_lock_path: inspection.target_lock_path,
    device: inspection.device,
    owner: inspection.owner,
    stopped_owner_proof: inspection.stopped_owner_proof,
    pre_tree_sha256: inspection.tree.sha256,
    post_tree_sha256: tree.sha256,
    tree_entry_count: tree.entry_count,
    tree_byte_length: tree.byte_length
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
