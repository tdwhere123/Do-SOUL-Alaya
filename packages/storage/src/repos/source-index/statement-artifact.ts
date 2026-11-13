import { createHash } from "node:crypto";
import {
  BoundSourceStatementSchema, canonicalJson, sourceStatementArtifact, sourceIndexStatementTarget,
  SourceIndexTargetSchema, type SourceStatementArtifact, type SourceIndexTarget, type SourceIndexBudget
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { putStatementDependencies, readStatementDependencies } from "./statement-dependencies.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const TARGET_BYTES = 8192;

/** Called only by the audited observation publication owner, in its guarded source transaction. */
export function putSourceStatementArtifact(database: StorageDatabase, input: SourceStatementArtifact): void {
  const bound = BoundSourceStatementSchema.parse(input.bound);
  const expected = sourceStatementArtifact(bound, input.artifact_id, sha256);
  if (canonicalJson(input) !== canonicalJson(expected)) throw new StorageError("VALIDATION_FAILED", "statement artifact identity mismatch");
  const source = database.connection.prepare(`SELECT source_id FROM source_records WHERE workspace_id=? AND record_id=?`)
    .get(bound.source_target.workspace_id, bound.source_target.root_id) as { source_id: string } | undefined;
  const evidence = database.connection.prepare(`SELECT gist,lifecycle_state FROM evidence_capsules WHERE workspace_id=? AND object_id=?`)
    .get(bound.source_target.workspace_id, input.artifact_id) as { gist: string; lifecycle_state: string } | undefined;
  if (source === undefined || evidence === undefined || evidence.lifecycle_state !== "active" ||
      canonicalJson(BoundSourceStatementSchema.parse(JSON.parse(evidence.gist))) !== canonicalJson(bound)) {
    throw new StorageError("VALIDATION_FAILED", "statement artifact has no published source evidence");
  }
  const target = sourceIndexStatementTarget(expected, source.source_id), json = canonicalJson(target);
  if (Buffer.byteLength(json) > TARGET_BYTES) throw new StorageError("VALIDATION_FAILED", "statement key metadata capacity exceeded");
  const existing = database.connection.prepare(`SELECT target_json,key_text FROM source_statement_artifacts WHERE workspace_id=? AND artifact_id=?`)
    .get(bound.source_target.workspace_id, input.artifact_id) as { target_json: string; key_text: string } | undefined;
  putStatementDependencies(database, expected, source.source_id);
  if (existing !== undefined) {
    if (existing.target_json !== json || existing.key_text !== expected.key_text) throw new StorageError("VALIDATION_FAILED", "statement artifact is immutable");
    return;
  }
  database.connection.prepare(`INSERT INTO source_statement_artifacts(workspace_id,artifact_id,record_id,source_id,target_json,key_text)
    VALUES(?,?,?,?,?,?)`).run(bound.source_target.workspace_id, input.artifact_id, bound.source_target.root_id, source.source_id, json, expected.key_text);
}

/** Missing is a non-statement capsule; neither malformed (partial) nor over-budget (resource_limited) is absence. */
export function readStatementIndexTarget(database: StorageDatabase, workspace: string, artifactId: string, budget: SourceIndexBudget) {
  const resources = { work: 0, native_bytes: 0 };
  if (budget.work < 1 || budget.native_bytes < TARGET_BYTES + 1) return { status: "resource_limited" as const, resources };
  const row = database.connection.prepare(`SELECT substr(CAST(target_json AS BLOB),1,?) AS target_json FROM source_statement_artifacts
    WHERE workspace_id=? AND artifact_id=?`).get(TARGET_BYTES + 1, workspace, artifactId) as { target_json: Buffer } | undefined;
  resources.work++;
  if (row === undefined) return { status: "absent" as const, resources };
  resources.native_bytes = row.target_json.length;
  if (row.target_json.length > TARGET_BYTES) return { status: "partial" as const, resources };
  let json: unknown;
  try { json = JSON.parse(row.target_json.toString("utf8")); } catch { return { status: "partial" as const, resources }; }
  const parsed = SourceIndexTargetSchema.safeParse(json);
  if (!parsed.success || parsed.data.auxiliary?.artifact_id !== artifactId || parsed.data.target.workspace_id !== workspace) {
    return { status: "partial" as const, resources };
  }
  const dependencies = readStatementDependencies(database, workspace, artifactId,
    { work: budget.work - resources.work, native_bytes: budget.native_bytes - resources.native_bytes });
  resources.work += dependencies.resources.work; resources.native_bytes += dependencies.resources.native_bytes;
  if (dependencies.status !== "ready") return { status: dependencies.status, resources };
  return { status: "ready" as const, source: parsed.data, resources };
}

/** Coordinates here address auxiliary key text only, never the source message. */
export function readStatementIndexChunk(database: StorageDatabase, source: SourceIndexTarget, maxBytes: number, offset: number) {
  const row = database.connection.prepare(`SELECT key_text FROM source_statement_artifacts WHERE workspace_id=? AND artifact_id=?
    AND target_json=? AND length(CAST(key_text AS BLOB))=?`).get(source.target.workspace_id, source.auxiliary?.artifact_id,
    canonicalJson(source), source.body_bytes) as { key_text: string } | undefined;
  if (row === undefined) return { row: null, resources: { work: 1, native_bytes: 0 } };
  const bytes = Buffer.from(row.key_text), resources = { work: 1, native_bytes: bytes.length };
  if (`sha256:${sha256(row.key_text)}` !== source.auxiliary?.key_digest || offset > bytes.length ||
      offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) return { row: null, resources };
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { row: { content: bytes.subarray(offset, end).toString("utf8"), content_end: end }, resources };
}
