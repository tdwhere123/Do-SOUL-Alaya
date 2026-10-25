import {
  canonicalJson, describeHostStructure, HostOccurrenceInventorySchema, HostStructureDescriptorSchema,
  type FieldContractSha256, type HostOccurrenceInventory, type SourceScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { readSourceProjectionDependencies, SOURCE_DEPENDENCY_METADATA_RESERVATION,
  SOURCE_RECORD_METADATA_BYTE_MAX as METADATA_MAX, SOURCE_RECORD_METADATA_COLUMNS as COLUMNS,
  CURRENT_SOURCE_RECORD_ORDER as CURRENT_ORDER } from "./source-representation-read.js";
import { fieldSourceRecordParser } from "./mappers/mappers.js";

const HEADER_RESERVATION = METADATA_MAX + 128;

export type HostInventoryReadInput = Readonly<{
  workspaceId: string; recordId: string; sourceVersion: string; contentDigest: string;
  authorizedScopes: readonly SourceScopeClass[] | null;
  nativeByteLimit: number; workLimit: number; memoryLimit: number;
}>;
export type HostInventoryReadResult = Readonly<{
  status: "unknown" | "captured" | "unavailable" | "resource_limited" | "invalid";
  inventory?: HostOccurrenceInventory;
  nativeBytes: number; work: number; memory: number;
}>;

/** Complete opt-in inventory read. Never hydrates body or returns a successful prefix. */
export function readHostInventory(database: StorageDatabase, input: HostInventoryReadInput,
  sha256: FieldContractSha256,
  columns: Readonly<{ hostStructure: boolean; representation: boolean }>): HostInventoryReadResult {
  let nativeBytes = 0, work = 0, memory = 0;
  const result = (status: HostInventoryReadResult["status"], inventory?: HostOccurrenceInventory): HostInventoryReadResult =>
    ({ status, ...(inventory === undefined ? {} : { inventory }), nativeBytes, work, memory });
  if ([input.nativeByteLimit, input.workLimit, input.memoryLimit].some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("invalid host inventory allowance");
  }
  if (input.authorizedScopes === undefined) return result("unavailable");
  if (input.nativeByteLimit < HEADER_RESERVATION || input.memoryLimit < 3 * HEADER_RESERVATION ||
      input.workLimit < 2 * HEADER_RESERVATION + 10) {
    return result("resource_limited");
  }
  return database.connection.transaction(() => {
    const value = (column: string) => (column === "host_structure_json" && !columns.hostStructure ||
      column === "source_representation_json" && !columns.representation) ? "NULL" : column;
    const metadataSize = COLUMNS.map(column => `COALESCE(octet_length(${value(column)}),0)`).join("+");
    const row = database.connection.prepare(`SELECT ${COLUMNS.map(column =>
      `CASE WHEN (${metadataSize}) <= ${METADATA_MAX} THEN ${value(column)} END AS ${column}`).join(",")},
      (${metadataSize}) AS metadata_bytes, source_body IS NOT NULL AS retained,
      (SELECT CASE WHEN octet_length(record_id) <= 71 THEN record_id END FROM source_records current INDEXED BY idx_source_records_current
        WHERE current.workspace_id = source_records.workspace_id AND current.source_id = source_records.source_id
        ORDER BY alaya_utc_order_key(current.recorded_at) DESC, current.record_id DESC LIMIT 1) AS current_id
      FROM source_records WHERE workspace_id = ? AND record_id = ?`).get(input.workspaceId, input.recordId) as
      Record<string, unknown> | undefined;
    work += 10;
    if (row === undefined) return result("unavailable");
    if (typeof row.metadata_bytes !== "number" || row.metadata_bytes > METADATA_MAX) return result("invalid");
    const headerBytes = row.metadata_bytes + (typeof row.current_id === "string" ? Buffer.byteLength(row.current_id) : 0) + 24;
    nativeBytes += headerBytes; memory += 3 * headerBytes; work += 2 * headerBytes;
    if (row.current_id !== input.recordId || row.retained !== 1 || row.source_version !== input.sourceVersion ||
        row.content_digest !== input.contentDigest || (input.authorizedScopes !== null &&
        !input.authorizedScopes.includes(row.scope_class as SourceScopeClass))) return result("unavailable");
    try {
      const source = fieldSourceRecordParser.parse({ ...row, source_body: null });
      const dependencyBytes = source.source_representation?.kind === "canonical_projection"
        ? SOURCE_DEPENDENCY_METADATA_RESERVATION * source.source_representation.source_record_ids.length : 0;
      if (memory + dependencyBytes > input.memoryLimit || work + dependencyBytes > input.workLimit) return result("resource_limited");
      const dependencies = readSourceProjectionDependencies(database, source, CURRENT_ORDER,
        { workLimit: input.workLimit - work - dependencyBytes, nativeByteLimit: input.nativeByteLimit - nativeBytes });
      nativeBytes += dependencies.metadataBytes; work += dependencies.work + dependencies.metadataBytes; memory += dependencies.metadataBytes;
      if (dependencies.resourceLimited) return result("resource_limited");
      if (!dependencies.available) return result("unavailable");
      if (source.host_structure === undefined) return result("unknown");
      const descriptor = HostStructureDescriptorSchema.parse(source.host_structure);
      const size = descriptor.encoded_bytes;
      // Reserve JSON materialization, decoded object, canonical validation and hash before fetching payload.
      if (nativeBytes + size + 8 > input.nativeByteLimit || memory + 3 * size + 8 > input.memoryLimit ||
          work + 2 * size + 2 > input.workLimit) return result("resource_limited");
      const payload = database.connection.prepare(`SELECT octet_length(canonical_inventory) AS bytes,
        CASE WHEN octet_length(canonical_inventory) = ? THEN canonical_inventory END AS inventory
        FROM source_host_inventories WHERE workspace_id = ? AND record_id = ?`)
        .get(size, input.workspaceId, input.recordId) as { bytes: number; inventory: string | null } | undefined;
      work += 2;
      if (payload === undefined) return result("unavailable");
      nativeBytes += 8; memory += 8;
      if (payload.bytes !== size || payload.inventory === null) return result("invalid");
      nativeBytes += size; memory += 3 * size; work += 2 * size;
      const inventory = HostOccurrenceInventorySchema.parse(JSON.parse(payload.inventory));
      if (canonicalJson(inventory) !== payload.inventory ||
          canonicalJson(describeHostStructure(source, inventory, sha256)) !== canonicalJson(descriptor)) return result("invalid");
      return result("captured", inventory);
    } catch {
      return result("invalid");
    }
  })();
}
