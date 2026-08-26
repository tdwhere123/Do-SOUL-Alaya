import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseJsonColumn } from "../shared/parse-json-column.js";
import {
  readObjectKeyEvidenceSources,
  type StoredObjectKeyEvidenceSource
} from "./object-key-source-reader.js";

export interface ObjectKeyRetrofitOwnerRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content: string;
  readonly evidence_refs: readonly string[];
}

export interface ObjectKeyRetrofitScan {
  readonly owners: readonly ObjectKeyRetrofitOwnerRow[];
  readonly evidence: readonly StoredObjectKeyEvidenceSource[];
}

const IN_CHUNK = 400;

export function scanObjectKeyRetrofitSources(db: StorageDatabase): Readonly<ObjectKeyRetrofitScan> {
  const refsByMemory = loadEvidenceRefs(db);
  const owners = loadOwners(db, refsByMemory);
  const evidence = loadEvidence(db, owners);
  return Object.freeze({ owners, evidence });
}

function loadOwners(
  db: StorageDatabase,
  refsByMemory: ReadonlyMap<string, readonly string[]>
): readonly ObjectKeyRetrofitOwnerRow[] {
  const rows = db.connection.prepare(`
    SELECT object_id, workspace_id, content, evidence_refs
    FROM memory_entries
    WHERE COALESCE(retention_state, '') != 'tombstoned'
      AND COALESCE(lifecycle_state, '') != 'dormant'
    ORDER BY workspace_id ASC, object_id ASC
  `).all() as ReadonlyArray<{
    readonly object_id: string;
    readonly workspace_id: string;
    readonly content: string;
    readonly evidence_refs: string;
  }>;
  return Object.freeze(rows.map((row) => Object.freeze({
    object_id: row.object_id,
    workspace_id: row.workspace_id,
    content: row.content,
    evidence_refs: uniqueRefs(
      refsByMemory.get(row.object_id) ?? [],
      parseEvidenceRefJson(row.evidence_refs)
    )
  })));
}

function loadEvidenceRefs(db: StorageDatabase): ReadonlyMap<string, readonly string[]> {
  const rows = db.connection.prepare(`
    SELECT memory_id, evidence_ref
    FROM memory_entry_evidence_refs
    ORDER BY memory_id ASC, evidence_ref ASC
  `).all() as ReadonlyArray<{ readonly memory_id: string; readonly evidence_ref: string }>;
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const current = grouped.get(row.memory_id) ?? [];
    current.push(row.evidence_ref);
    grouped.set(row.memory_id, current);
  }
  return grouped;
}

function loadEvidence(
  db: StorageDatabase,
  owners: readonly ObjectKeyRetrofitOwnerRow[]
): readonly StoredObjectKeyEvidenceSource[] {
  const byWorkspace = groupEvidenceIds(owners);
  const evidence: StoredObjectKeyEvidenceSource[] = [];
  for (const [workspaceId, ids] of byWorkspace) {
    const list = [...ids];
    for (let index = 0; index < list.length; index += IN_CHUNK) {
      evidence.push(
        ...readObjectKeyEvidenceSources(db, workspaceId, list.slice(index, index + IN_CHUNK))
      );
    }
  }
  return Object.freeze(evidence);
}

function groupEvidenceIds(
  owners: readonly ObjectKeyRetrofitOwnerRow[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const byWorkspace = new Map<string, Set<string>>();
  for (const owner of owners) {
    const ids = byWorkspace.get(owner.workspace_id) ?? new Set<string>();
    for (const id of owner.evidence_refs) ids.add(id);
    byWorkspace.set(owner.workspace_id, ids);
  }
  return byWorkspace;
}

function parseEvidenceRefJson(value: string | null): readonly string[] {
  if (value === null || value.length === 0) return [];
  const parsed = parseJsonColumn(value, "evidence_refs");
  if (!Array.isArray(parsed)) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate evidence_refs JSON.");
  }
  return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function uniqueRefs(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())];
}
