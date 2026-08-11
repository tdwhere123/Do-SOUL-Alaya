import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  assertRelationProjectionCurrent,
  initDatabase
} from "@do-soul/alaya-storage";

export function checkpointAndCopyBenchDb(
  liveDbPath: string,
  snapshotDbPath: string
): void {
  const db = initDatabase({ filename: liveDbPath });
  assertRelationProjectionCurrent(db);
  const [checkpoint] = db.connection.pragma(
    "wal_checkpoint(TRUNCATE)"
  ) as Array<{
    readonly busy: number;
    readonly log: number;
    readonly checkpointed: number;
  }>;
  if (checkpoint === undefined || checkpoint.busy !== 0 ||
      checkpoint.log !== checkpoint.checkpointed) {
    const detail = checkpoint === undefined
      ? "missing checkpoint status"
      : `busy=${checkpoint.busy} log=${checkpoint.log} checkpointed=${checkpoint.checkpointed}`;
    throw new Error(`cannot freeze live bench DB: incomplete WAL checkpoint (${detail})`);
  }
  atomicCopy(liveDbPath, snapshotDbPath);
}

export function atomicCopy(fromPath: string, toPath: string): void {
  mkdirSync(dirname(toPath), { recursive: true });
  const tmpPath = `${toPath}.${randomUUID()}.tmp`;
  copyFileSync(fromPath, tmpPath);
  renameSync(tmpPath, toPath);
}
