import { retrofitMemoryObjectKeys, type ObjectKeyRetrofitReport } from "@do-soul/alaya-core";
import {
  initDatabase,
  scanObjectKeyRetrofitSources,
  SqliteMemoryObjectKeyRepo
} from "@do-soul/alaya-storage";

export function retrofitObjectKeysOnSnapshot(snapshotPath: string): ObjectKeyRetrofitReport {
  const started = Date.now();
  const db = initDatabase({
    filename: snapshotPath,
    temporalMode: "candidate",
    busyTimeoutMs: 120_000
  });
  try {
    const scan = scanObjectKeyRetrofitSources(db);
    const keys = new SqliteMemoryObjectKeyRepo(db);
    const report = db.connection.transaction(() => retrofitMemoryObjectKeys({
      owners: scan.owners,
      evidence: scan.evidence,
      replaceOwnerKeys: (workspaceId, ownerId, minted) =>
        keys.replaceOwnerKeys(workspaceId, ownerId, minted)
    })).immediate();
    return Object.freeze({ ...report, elapsed_ms: Date.now() - started });
  } finally {
    db.close();
  }
}
