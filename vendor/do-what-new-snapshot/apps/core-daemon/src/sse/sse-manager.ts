import { randomUUID } from "node:crypto";
import type { WritableStreamDefaultWriter } from "node:stream/web";
import { Phase4BEventType, type EventLogEntry, type Phase0Event } from "@do-what/protocol";
import type { SseBroadcaster } from "@do-what/core";

interface ManagedConnection {
  readonly connectionId: string;
  readonly scope: "run" | "workspace";
  readonly scopeId: string;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}

interface SseFrame {
  readonly id?: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface SseEventLogRepoPort {
  queryByRunAfterEventId(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  queryByWorkspaceAfterEventId(workspaceId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
}

export class SseManager implements SseBroadcaster {
  private readonly encoder = new TextEncoder();
  private readonly connectionsById = new Map<string, ManagedConnection>();
  private readonly runConnections = new Map<string, Set<string>>();
  private readonly workspaceConnections = new Map<string, Set<string>>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  // Connections still in replay. Tracks both buffered live frames and already-replayed
  // event IDs so markReplayComplete() can skip duplicates in the buffer.
  private readonly replayBuffers = new Map<string, { buffer: SseFrame[]; replayedIds: Set<string> }>();

  public constructor(private readonly eventLogRepo: SseEventLogRepoPort) {}

  public subscribe(runId: string, writer: WritableStreamDefaultWriter<Uint8Array>): string {
    return this.subscribeScoped("run", runId, writer);
  }

  public subscribeWorkspace(
    workspaceId: string,
    writer: WritableStreamDefaultWriter<Uint8Array>
  ): string {
    return this.subscribeScoped("workspace", workspaceId, writer);
  }

  public unsubscribe(connectionId: string): void {
    const connection = this.connectionsById.get(connectionId);

    if (connection === undefined) {
      return;
    }

    this.connectionsById.delete(connectionId);
    this.replayBuffers.delete(connectionId);

    if (connection.scope === "run") {
      const runScopedConnections = this.runConnections.get(connection.scopeId);
      if (runScopedConnections !== undefined) {
        runScopedConnections.delete(connectionId);
        if (runScopedConnections.size === 0) {
          this.runConnections.delete(connection.scopeId);
        }
      }
    } else {
      const workspaceScopedConnections = this.workspaceConnections.get(connection.scopeId);
      if (workspaceScopedConnections !== undefined) {
        workspaceScopedConnections.delete(connectionId);
        if (workspaceScopedConnections.size === 0) {
          this.workspaceConnections.delete(connection.scopeId);
        }
      }
    }

    const pendingWrite = this.writeQueues.get(connectionId) ?? Promise.resolve();
    this.writeQueues.delete(connectionId);

    void pendingWrite.finally(async () => {
      try {
        await connection.writer.close();
      } catch {
        // Best effort close; stream may already be closed by the client.
      }
    });
  }

  public unsubscribeWorkspace(connectionId: string): void {
    this.unsubscribe(connectionId);
  }

  public connectionCount(runId?: string, workspaceId?: string): number {
    if (runId !== undefined) {
      return this.runConnections.get(runId)?.size ?? 0;
    }

    if (workspaceId !== undefined) {
      return this.workspaceConnections.get(workspaceId)?.size ?? 0;
    }

    return this.connectionsById.size;
  }

  public async getLatestEventId(runId: string): Promise<string | null> {
    return findLatestVisibleEventId(
      await this.eventLogRepo.queryByRunAfterEventId(runId, "__do_what_initial_cursor__")
    );
  }

  public async getLatestWorkspaceEventId(workspaceId: string): Promise<string | null> {
    return findLatestVisibleEventId(
      await this.eventLogRepo.queryByWorkspaceAfterEventId(workspaceId, "__do_what_initial_cursor__")
    );
  }

  public async sendConnected(
    connectionId: string,
    runId: string,
    latestEventId: string | null,
    isReconnect: boolean
  ): Promise<void> {
    const connection = this.connectionsById.get(connectionId);

    if (connection === undefined) {
      return;
    }

    // On reconnect: omit `id` so the browser retains its existing Last-Event-ID cursor
    // and does not jump forward past events it hasn't received yet (7952beb fix).
    // On first connect: set `id` to seed the cursor so the client can replay missed
    // events if it disconnects before receiving any real event.
    await this.enqueueFrame(connection, {
      id: isReconnect ? undefined : getInitialCursorSeed(connectionId, latestEventId),
      event: "connected",
      data: {
        run_id: runId,
        connection_id: connectionId,
        last_event_id: latestEventId
      }
    });
  }

  public async sendWorkspaceConnected(
    connectionId: string,
    workspaceId: string,
    latestEventId: string | null,
    isReconnect: boolean
  ): Promise<void> {
    const connection = this.connectionsById.get(connectionId);

    if (connection === undefined) {
      return;
    }

    await this.enqueueFrame(connection, {
      id: isReconnect ? undefined : getInitialCursorSeed(connectionId, latestEventId),
      event: "connected",
      data: {
        workspace_id: workspaceId,
        connection_id: connectionId,
        last_event_id: latestEventId
      }
    });
  }

  /**
   * Called after replay is complete. Flushes buffered live frames and allows
   * subsequent broadcasts to be delivered directly to this connection.
   */
  public markReplayComplete(connectionId: string): void {
    const replayInfo = this.replayBuffers.get(connectionId);

    if (replayInfo === undefined) {
      return;
    }

    this.replayBuffers.delete(connectionId);

    const connection = this.connectionsById.get(connectionId);
    if (connection === undefined) {
      return;
    }

    // Skip frames whose event_id was already sent during replay to prevent duplicates.
    // This covers the race window where a live broadcast arrives after subscribe() but
    // before the replay DB query returns, causing the same event to appear in both.
    for (const frame of replayInfo.buffer) {
      if (frame.id !== undefined && replayInfo.replayedIds.has(frame.id)) {
        continue;
      }
      void this.enqueueFrame(connection, frame);
    }
  }

  public async replayFrom(runId: string, lastEventId: string, connectionId: string): Promise<number> {
    const connection = this.connectionsById.get(connectionId);

    if (connection === undefined) {
      return 0;
    }

    const entries = await this.eventLogRepo.queryByRunAfterEventId(runId, lastEventId);
    const replayInfo = this.replayBuffers.get(connectionId);

    let delivered = 0;

    for (const entry of entries) {
      if (!shouldStreamEntry(entry)) {
        continue;
      }

      replayInfo?.replayedIds.add(entry.event_id);
      await this.enqueueFrame(connection, toSseFrame(entry));
      delivered += 1;
    }

    return delivered;
  }

  public async replayWorkspaceFrom(
    workspaceId: string,
    lastEventId: string,
    connectionId: string
  ): Promise<number> {
    const connection = this.connectionsById.get(connectionId);

    if (connection === undefined) {
      return 0;
    }

    const entries = await this.eventLogRepo.queryByWorkspaceAfterEventId(workspaceId, lastEventId);
    const replayInfo = this.replayBuffers.get(connectionId);

    let delivered = 0;

    for (const entry of entries) {
      if (!shouldStreamEntry(entry)) {
        continue;
      }

      replayInfo?.replayedIds.add(entry.event_id);
      await this.enqueueFrame(connection, toSseFrame(entry));
      delivered += 1;
    }

    return delivered;
  }

  public broadcast(runId: string, event: Phase0Event): void {
    this.broadcastToRunConnections(runId, {
      id: event.event_id,
      event: event.event_type,
      data: event.payload
    });

    this.broadcastToWorkspaceConnections(event.workspace_id, {
      id: event.event_id,
      event: event.event_type,
      data: event.payload
    });
  }

  public broadcastEntry(entry: EventLogEntry): void {
    if (!shouldStreamEntry(entry)) {
      return;
    }

    const frame = toSseFrame(entry);

    if (entry.run_id !== null) {
      this.broadcastToRunConnections(entry.run_id, frame);
    }

    this.broadcastToWorkspaceConnections(entry.workspace_id, frame);
  }

  private subscribeScoped(
    scope: "run" | "workspace",
    scopeId: string,
    writer: WritableStreamDefaultWriter<Uint8Array>
  ): string {
    const connectionId = `conn_${randomUUID()}`;
    const connection: ManagedConnection = {
      connectionId,
      scope,
      scopeId,
      writer
    };

    this.connectionsById.set(connectionId, connection);
    this.writeQueues.set(connectionId, Promise.resolve());
    this.replayBuffers.set(connectionId, { buffer: [], replayedIds: new Set() });

    if (scope === "run") {
      let connections = this.runConnections.get(scopeId);
      if (connections === undefined) {
        connections = new Set<string>();
        this.runConnections.set(scopeId, connections);
      }
      connections.add(connectionId);
    } else {
      let connections = this.workspaceConnections.get(scopeId);
      if (connections === undefined) {
        connections = new Set<string>();
        this.workspaceConnections.set(scopeId, connections);
      }
      connections.add(connectionId);
    }

    return connectionId;
  }

  private broadcastToRunConnections(runId: string, frame: SseFrame): void {
    const connectionIds = this.runConnections.get(runId);

    if (connectionIds === undefined || connectionIds.size === 0) {
      return;
    }

    for (const connectionId of connectionIds) {
      const replayInfo = this.replayBuffers.get(connectionId);
      if (replayInfo !== undefined) {
        // Replay is still in progress — buffer live frames to preserve ordering.
        replayInfo.buffer.push(frame);
        continue;
      }

      const connection = this.connectionsById.get(connectionId);
      if (connection === undefined) {
        continue;
      }

      void this.enqueueFrame(connection, frame);
    }
  }

  private broadcastToWorkspaceConnections(workspaceId: string, frame: SseFrame): void {
    const connectionIds = this.workspaceConnections.get(workspaceId);

    if (connectionIds === undefined || connectionIds.size === 0) {
      return;
    }

    for (const connectionId of connectionIds) {
      const replayInfo = this.replayBuffers.get(connectionId);
      if (replayInfo !== undefined) {
        replayInfo.buffer.push(frame);
        continue;
      }

      const connection = this.connectionsById.get(connectionId);
      if (connection === undefined) {
        continue;
      }

      void this.enqueueFrame(connection, frame);
    }
  }

  private enqueueFrame(connection: ManagedConnection, frame: SseFrame): Promise<void> {
    const pendingWrite = this.writeQueues.get(connection.connectionId) ?? Promise.resolve();
    const nextWrite = pendingWrite
      .then(() => connection.writer.write(this.encoder.encode(formatSseFrame(frame))))
      .catch(() => {
        this.unsubscribe(connection.connectionId);
      });

    this.writeQueues.set(connection.connectionId, nextWrite);
    return nextWrite;
  }
}

function shouldStreamEntry(entry: Readonly<EventLogEntry>): boolean {
  if (entry.event_type !== Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED) {
    return true;
  }

  const payload = entry.payload_json;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return true;
  }

  return payload.exploration_kind !== "path_topology";
}

function toSseFrame(entry: EventLogEntry): SseFrame {
  return {
    id: entry.event_id,
    event: entry.event_type,
    data: entry.payload_json as Record<string, unknown>
  };
}

function findLatestVisibleEventId(entries: readonly Readonly<EventLogEntry>[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (shouldStreamEntry(entry)) {
      return entry.event_id;
    }
  }

  return null;
}

function formatSseFrame(frame: SseFrame): string {
  const idLine = frame.id !== undefined ? `id: ${frame.id}\n` : "";
  return `${idLine}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

function getInitialCursorSeed(connectionId: string, latestEventId: string | null): string {
  return latestEventId ?? `connected:${connectionId}`;
}
