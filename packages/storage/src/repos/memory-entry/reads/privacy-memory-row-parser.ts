import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { requirePrivacyObjectAvailable } from "../../field/privacy-availability.js";
import type { RowParser } from "../../shared/parse-row.js";
import { MemoryEntryRowParser } from "../mappers/row-mapper.js";

export function createPrivacyMemoryRowParser(database: StorageDatabase): RowParser<Readonly<MemoryEntry>> {
  return { parse(value) {
    const row = MemoryEntryRowParser.parse(value);
    requirePrivacyObjectAvailable(database, row.workspace_id, "memory_entry", row.object_id);
    return row;
  } };
}
