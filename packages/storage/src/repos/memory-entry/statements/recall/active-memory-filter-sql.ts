import { CURRENT_STATEMENT_MEMORY_FILTER_SQL } from "../../../source-index/statement-dependencies.js";
import type { StorageTier } from "@do-soul/alaya-protocol";

export const ACTIVE_MEMORY_FILTER_SQL = `
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
        ${CURRENT_STATEMENT_MEMORY_FILTER_SQL}
`;

export const ACTIVE_MEMORY_ENTRIES_FILTER_SQL = `
      AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
      AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ${CURRENT_STATEMENT_MEMORY_FILTER_SQL}
`;

export function memoryTierFilterSql(
  tier: StorageTier | undefined,
  column: "storage_tier" | "memory_entries.storage_tier" = "storage_tier"
): string {
  return tier === undefined ? "" : `AND ${column} = ?`;
}
