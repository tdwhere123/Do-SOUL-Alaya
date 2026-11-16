import { readFileSync } from "node:fs";
import type { StorageDatabase } from "../../sqlite/db.js";

/** Legacy-upgrade fixtures must remove the dependent preservation layer before
 * removing quarantine/repair tables. Never use this on retained capture data.
 * Reopen reapplies the real migration; no production protection is disabled.
 */
export function removeHistoricalPreservationMigration(database: StorageDatabase): void {
  const preservation = readFileSync(new URL("../../migrations/046-independent-memory-preservation.sql", import.meta.url), "utf8");
  const quarantine = readFileSync(new URL("../../migrations/036-unavailable-dependency-quarantine.sql", import.meta.url), "utf8");
  const viewStart = quarantine.indexOf("CREATE VIEW privacy_dependency_candidates AS");
  const viewEnd = quarantine.indexOf("\nINSERT OR IGNORE INTO privacy_dependency_quarantine", viewStart);
  if (viewStart < 0 || viewEnd < 0) throw new Error("Legacy quarantine view definition is missing");
  const objects = [...preservation.matchAll(/\bCREATE (TRIGGER|VIEW|TABLE) (\w+)/g)]
    .map(match => ({ type: match[1]!, name: match[2]! }));
  database.connection.transaction(() => {
    if (database.connection.prepare("SELECT 1 FROM historical_memory_captures LIMIT 1").get() !== undefined) {
      throw new Error("Cannot downgrade a fixture containing historical captures");
    }
    for (const type of ["TRIGGER", "VIEW", "TABLE"]) {
      // Reverse declaration order drops capture-source children before their parent.
      for (const object of objects.filter(object => object.type === type).reverse()) {
        database.connection.exec(`DROP ${object.type} ${object.name}`);
      }
    }
    // Migration 46 replaces this older view as well as adding its own objects.
    database.connection.exec(quarantine.slice(viewStart, viewEnd));
    database.connection.prepare("DELETE FROM schema_version WHERE version = 46").run();
  }).immediate();
}
