import type { Continuation, InformationIndex, RequestBudget } from "@do-soul/alaya-protocol";
import type { SqliteIndexedRecallProjection, SqliteMemoryRecallReader, SqliteRelationRecallReader } from "@do-soul/alaya-storage";
import { captureIndexPreviews, runConditionalFieldRecall, snapshotIdFromPin, toSourceObserverRow, type ObserverReaders } from "../../../recall/recall-service.js";
import { defaultBudget } from "../conditional-field/reference/deployment.fixture.js";
import { NOW, WS } from "./ids.js";

export interface LocalRecallInput {
  readonly text: string;
  readonly asOf?: string;
  readonly budget?: Partial<RequestBudget>;
  readonly continuation?: Continuation | null;
  readonly familyCaps?: Readonly<{ lexical?: string; typed_relation?: string; embedding?: string }>;
}

export function localTargetRecall(input: LocalRecallInput, ports: {
  readonly memoryReader: SqliteMemoryRecallReader;
  readonly recallReader: SqliteRelationRecallReader;
  readonly indexProjection: SqliteIndexedRecallProjection;
}, cancelled = false) {
  let nativeVisits = 0;
  let sourceReads = 0;
  let bytesRead = 0;
  const readers: ObserverReaders = {
    ...(input.familyCaps?.lexical === "unavailable" ? {} : {
      lexical: (request: Parameters<NonNullable<ObserverReaders["lexical"]>>[0]) => {
        const page = ports.memoryReader.lexical(request.workspaceId, request.query,
          request.limit, request.nativeLimit, request.afterObjectId);
        nativeVisits += page.nativeVisits;
        bytesRead += page.bytesRead;
        return page;
      }
    }),
    source: (request) => {
      const page = ports.memoryReader.source(request.workspaceId, request.objectId);
      sourceReads += page.rowsRead;
      bytesRead += page.bytesRead;
      return { ...page, row: page.row === null ? null : toSourceObserverRow(page.row) };
    },
    ...(input.familyCaps?.typed_relation === "unavailable" ? {} : {
      relation: (request: Parameters<NonNullable<ObserverReaders["relation"]>>[0]) => {
        const page = ports.recallReader.read(request.workspaceId, request.subject,
          request.predicate, request.limit, request.nativeLimit, request.afterAssertionId);
        nativeVisits += page.nativeVisits;
        bytesRead += page.bytesRead;
        return page;
      }
    }),
    snapshotPin: (workspaceId) => ports.indexProjection.observablePin(workspaceId)
  };
  const started = performance.now();
  const index: InformationIndex = runConditionalFieldRecall({
    workspace_id: WS,
    query_text: input.text,
    snapshot_id: snapshotIdFromPin(WS, ports.indexProjection.observablePin(WS)),
    interpretation_clock: input.asOf ?? NOW,
    as_of: input.asOf ?? NOW,
    expires_at: "2099-01-01T00:00:00.000Z",
    lifetime_now: NOW,
    budget: defaultBudget(input.budget),
    readers,
    cancelled,
    authorized_scopes: null,
    ...(input.continuation === undefined ? {} : { continuation: input.continuation })
  });
  return { index, membership: index.entries.map((entry) => entry.object_id),
    previews: captureIndexPreviews(index, readers, WS),
    observation: { nativeVisits, sourceReads, bytesRead, elapsedMs: performance.now() - started } };
}
