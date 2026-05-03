import {
  Phase0EventSchema,
  type EventLogEntry,
  type Phase0Event
} from "@do-soul/alaya-protocol";
import type { RuntimeNotifier } from "@do-soul/alaya-core";

export interface RuntimeNotifierSubscription {
  dispose(): void;
}

export type RuntimeEventListener = (event: Phase0Event) => void | Promise<void>;
export type RuntimeEntryListener = (entry: EventLogEntry) => void | Promise<void>;

export interface AlayaRuntimeNotifier extends RuntimeNotifier {
  subscribeRun(runId: string, listener: RuntimeEventListener): RuntimeNotifierSubscription;
  subscribeWorkspace(workspaceId: string, listener: RuntimeEntryListener): RuntimeNotifierSubscription;
  subscribeEntries(listener: RuntimeEntryListener): RuntimeNotifierSubscription;
}

export function createRuntimeNotifier(): AlayaRuntimeNotifier {
  return new InProcessRuntimeNotifier();
}

class InProcessRuntimeNotifier implements AlayaRuntimeNotifier {
  private readonly runListeners = new Map<string, Set<RuntimeEventListener>>();
  private readonly workspaceListeners = new Map<string, Set<RuntimeEntryListener>>();
  private readonly entryListeners = new Set<RuntimeEntryListener>();

  public subscribeRun(runId: string, listener: RuntimeEventListener): RuntimeNotifierSubscription {
    const listeners = getOrCreateSet(this.runListeners, runId);
    listeners.add(listener);
    return createSubscription(() => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.runListeners.delete(runId);
      }
    });
  }

  public subscribeWorkspace(workspaceId: string, listener: RuntimeEntryListener): RuntimeNotifierSubscription {
    const listeners = getOrCreateSet(this.workspaceListeners, workspaceId);
    listeners.add(listener);
    return createSubscription(() => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.workspaceListeners.delete(workspaceId);
      }
    });
  }

  public subscribeEntries(listener: RuntimeEntryListener): RuntimeNotifierSubscription {
    this.entryListeners.add(listener);
    return createSubscription(() => {
      this.entryListeners.delete(listener);
    });
  }

  public async notify(runId: string, event: Phase0Event): Promise<void> {
    await notifyAll(this.runListeners.get(runId), event);
  }

  public async notifyEntry(entry: EventLogEntry): Promise<void> {
    await notifyAll(this.entryListeners, entry);
    await notifyAll(this.workspaceListeners.get(entry.workspace_id), entry);

    if (entry.run_id !== null) {
      const event = Phase0EventSchema.safeParse({
        event_id: entry.event_id,
        event_type: entry.event_type,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: entry.caused_by,
        revision: entry.revision,
        created_at: entry.created_at,
        payload: entry.payload_json
      });

      if (event.success) {
        await this.notify(entry.run_id, event.data);
      }
    }
  }
}

function getOrCreateSet<TKey, TValue>(map: Map<TKey, Set<TValue>>, key: TKey): Set<TValue> {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const created = new Set<TValue>();
  map.set(key, created);
  return created;
}

function createSubscription(dispose: () => void): RuntimeNotifierSubscription {
  let active = true;
  return Object.freeze({
    dispose: () => {
      if (!active) {
        return;
      }
      active = false;
      dispose();
    }
  });
}

async function notifyAll<TValue>(listeners: ReadonlySet<(value: TValue) => void | Promise<void>> | undefined, value: TValue): Promise<void> {
  if (listeners === undefined || listeners.size === 0) {
    return;
  }

  for (const listener of [...listeners]) {
    try {
      await listener(value);
    } catch (error) {
      console.warn("[runtime-notifier] listener threw; continuing fan-out", {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
      });
    }
  }
}
