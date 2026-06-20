import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { SnapshotCompactionError } from "./run-snapshot-compaction.js";

const SNAPSHOT_REPLAY_PAGE_SIZE = 500;

export interface SnapshotCursorState {
  readonly cursorExists: boolean;
  readonly eventsUpToCursor: number;
  readonly latestEventId: string | null;
}

export type SnapshotEventLogRepo = {
  queryByRunPage?(
    runId: string,
    page: { readonly limit: number; readonly offset: number }
  ): Promise<readonly EventLogEntry[]>;
  queryByRunAfterEventId?(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  queryByRunCursorState?(
    runId: string,
    lastEventId: string | null
  ): Promise<SnapshotCursorState>;
};

export async function queryRunEventLog(
  eventLogRepo: SnapshotEventLogRepo,
  runId: string
): Promise<readonly EventLogEntry[]> {
  if (eventLogRepo.queryByRunPage === undefined) {
    throw new SnapshotCompactionError(
      `Cannot compact snapshot for ${runId}: eventLogRepo.queryByRunPage is required for bounded replay`
    );
  }

  const events: EventLogEntry[] = [];
  for (;;) {
    const page = await eventLogRepo.queryByRunPage(runId, {
      limit: SNAPSHOT_REPLAY_PAGE_SIZE,
      offset: events.length
    });
    events.push(...page);
    if (page.length < SNAPSHOT_REPLAY_PAGE_SIZE) {
      return Object.freeze(events);
    }
  }
}
