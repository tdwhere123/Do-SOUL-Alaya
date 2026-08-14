import { LegacyPathIndexUnboundError } from "@do-soul/alaya-core";
import {
  isLegacyPathIndexUnbound,
  isRelationProjectionReadable,
  isTemporalProjectionSelected,
  SqlitePathRelationRepo,
  SqliteRelationAssertionRepo,
  SqliteTemporalPathProjectionReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  createPreparedTemporalRecallPathReadPorts,
  createRecallPathReadPorts,
  type LegacyRecallPathReader,
  type RecallPathReadPorts
} from "./recall-path-readers.js";

export type RecallPathReadBind = "temporal" | "legacy";

export function resolveRecallPathReadBind(input: {
  readonly database: StorageDatabase;
  readonly pathReadBind?: RecallPathReadBind;
}): RecallPathReadBind {
  if (input.pathReadBind !== undefined) return input.pathReadBind;
  // Ready unselected projections are the live path index; the selected bit is write-side protocol.
  if (isTemporalProjectionSelected(input.database) || isRelationProjectionReadable(input.database)) {
    return "temporal";
  }
  return "legacy";
}

export function createBoundRecallPathReadPorts(input: {
  readonly database: StorageDatabase;
  readonly pathReadBind?: RecallPathReadBind;
}): RecallPathReadPorts {
  if (resolveRecallPathReadBind(input) === "temporal") {
    return createPreparedTemporalRecallPathReadPorts(
      new SqliteTemporalPathProjectionReader(new SqliteRelationAssertionRepo(input.database))
    );
  }
  return createRecallPathReadPorts({
    legacyPathReader: wrapLegacyPathReaderForIndexHealth(
      new SqlitePathRelationRepo(input.database),
      () => isLegacyPathIndexUnbound(input.database) ? "index_unavailable" : "ready"
    )
  });
}

export function wrapLegacyPathReaderForIndexHealth(
  reader: LegacyRecallPathReader,
  inspect: () => "ready" | "index_unavailable"
): LegacyRecallPathReader {
  const assertBound = (): void => {
    if (inspect() === "index_unavailable") {
      throw new LegacyPathIndexUnboundError();
    }
  };
  return {
    findByAnchors: async (workspaceId, anchorRefs) => {
      assertBound();
      return await reader.findByAnchors(workspaceId, anchorRefs);
    },
    findByWorkspaceAll: async (workspaceId) => {
      assertBound();
      return await reader.findByWorkspaceAll(workspaceId);
    },
    findActiveAll: async (workspaceId) => {
      assertBound();
      return await reader.findActiveAll(workspaceId);
    }
  };
}
