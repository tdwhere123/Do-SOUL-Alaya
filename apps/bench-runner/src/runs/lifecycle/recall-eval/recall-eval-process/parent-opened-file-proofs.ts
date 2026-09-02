import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureRegularFileSha256,
  seedRegularFileSha256,
  type OpenedFileSha256
} from "../../../snapshot/bound-file.js";
import { packedWorkingDbPath } from
  "../../../snapshot/recall-eval/workspace-slice/install.js";
import { captureSealedSliceMainFileProofs } from
  "../../../snapshot/recall-eval/workspace-slice/sealed-cache.js";

export function proveParentOpenedFileProofs(payload: unknown): unknown {
  const snapshotDbPath = snapshotDbPathOf(payload);
  if (snapshotDbPath === undefined) return payload;
  const record = payload as Record<string, unknown>;
  const existing = parseOpenedFileProofs(record.parentOpenedFileProofs);
  if (record.parentOpenedFileProofs !== undefined && existing === undefined) {
    throw new Error("recall-eval parent opened-file proofs are invalid");
  }
  const proofs: Record<string, OpenedFileSha256> = { ...existing };
  const resolvedSnapshot = resolve(snapshotDbPath);
  if (proofs[resolvedSnapshot] === undefined) {
    const captured = captureRegularFileSha256(snapshotDbPath);
    const expected = manifestDbSha256(record);
    if (expected !== undefined && captured.sha256 !== expected) {
      throw new Error("recall-eval snapshot DB SHA-256 mismatch");
    }
    proofs[resolvedSnapshot] = captured;
  }
  const dataDirRoot = dataDirRootOf(record);
  if (dataDirRoot !== undefined) {
    addPackedWorkingCopyProof(
      proofs,
      dataDirRoot,
      proofs[resolvedSnapshot]?.sha256
    );
  }
  Object.assign(proofs, captureSealedSliceMainFileProofs(snapshotDbPath));
  return {
    ...record,
    parentOpenedFileProofs: Object.freeze(proofs)
  };
}

export function seedParentOpenedFileProofs(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const record = payload as Record<string, unknown>;
  if (!Object.hasOwn(record, "parentOpenedFileProofs") ||
      record.parentOpenedFileProofs === undefined) {
    return;
  }
  const proofs = parseOpenedFileProofs(record.parentOpenedFileProofs);
  if (proofs === undefined) {
    throw new Error("recall-eval parent opened-file proofs are invalid");
  }
  const expected = manifestDbSha256(record);
  const snapshotDbPath = snapshotDbPathOf(payload);
  for (const [filePath, proof] of Object.entries(proofs)) {
    if (expected !== undefined && snapshotDbPath !== undefined &&
        resolve(filePath) === resolve(snapshotDbPath) &&
        proof.sha256 !== expected) {
      throw new Error("recall-eval snapshot DB SHA-256 mismatch");
    }
    seedRegularFileSha256({
      filePath,
      expectedIdentity: proof,
      sha256: proof.sha256
    });
  }
}

function addPackedWorkingCopyProof(
  proofs: Record<string, OpenedFileSha256>,
  dataDirRoot: string,
  expectedSha256: string | undefined
): void {
  const packed = packedWorkingDbPath(dataDirRoot);
  if (!existsSync(packed)) return;
  const resolved = resolve(packed);
  if (proofs[resolved] !== undefined) return;
  const captured = captureRegularFileSha256(packed);
  if (expectedSha256 !== undefined && captured.sha256 !== expectedSha256) {
    throw new Error("recall-eval snapshot DB SHA-256 mismatch");
  }
  proofs[resolved] = captured;
}

function snapshotDbPathOf(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.options)) return undefined;
  const snapshotDbPath = payload.options.snapshotDbPath;
  return typeof snapshotDbPath === "string" && snapshotDbPath.length > 0
    ? snapshotDbPath
    : undefined;
}

function dataDirRootOf(record: Record<string, unknown>): string | undefined {
  return typeof record.dataDirRoot === "string" && record.dataDirRoot.length > 0
    ? record.dataDirRoot
    : undefined;
}

function manifestDbSha256(record: Record<string, unknown>): string | undefined {
  if (!isRecord(record.manifest) || !isRecord(record.manifest.artifact_integrity)) {
    return undefined;
  }
  const digest = record.manifest.artifact_integrity.db_sha256;
  return typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)
    ? digest
    : undefined;
}

function parseOpenedFileProofs(
  value: unknown
): Readonly<Record<string, OpenedFileSha256>> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const proofs: Record<string, OpenedFileSha256> = {};
  for (const [filePath, proof] of Object.entries(value)) {
    if (filePath.length === 0 || !isOpenedFileSha256(proof)) return undefined;
    proofs[filePath] = proof;
  }
  return proofs;
}

function isOpenedFileSha256(value: unknown): value is OpenedFileSha256 {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.dev) && isFiniteNumber(value.ino) &&
    isFiniteNumber(value.ctimeMs) && isFiniteNumber(value.size) &&
    isFiniteNumber(value.mtimeMs) &&
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
