import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import type { BenchDaemonHandle } from "../daemon-types.js";
import { optimizeBenchDb } from "./daemon-db-pragmas.js";

export function createRelationProjectionCheckpointOperation(input: {
  readonly dataDir: string;
  readonly runtime: AlayaDaemonRuntime;
}): BenchDaemonHandle["checkpointRelationProjection"] {
  return async (): Promise<void> => {
    const refreshed = await input.runtime.services.relationProjectionCheckpoint.refresh();
    if (refreshed) optimizeBenchDb(input.dataDir);
  };
}
