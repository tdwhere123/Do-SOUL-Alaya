import {
  WorkspaceRunEventSchema,
  type EventLogEntry,
  type WorkspaceRunEvent
} from "@do-soul/alaya-protocol";
import type { RuntimeNotifier } from "@do-soul/alaya-core";
import { createWarnLogger } from "./daemon-runtime-helpers.js";

export interface RuntimeNotifierSubscription {
  dispose(): void;
}

export type RuntimeEventListener = (event: WorkspaceRunEvent) => void | Promise<void>;
export type RuntimeEntryListener = (entry: EventLogEntry) => void | Promise<void>;

export interface AlayaRuntimeNotifier extends RuntimeNotifier {
  subscribeRun(runId: string, listener: RuntimeEventListener): RuntimeNotifierSubscription;
  subscribeWorkspace(workspaceId: string, listener: RuntimeEntryListener): RuntimeNotifierSubscription;
  subscribeEntries(listener: RuntimeEntryListener): RuntimeNotifierSubscription;
}

export function createRuntimeNotifier(): AlayaRuntimeNotifier {
  return new InProcessRuntimeNotifier();
}

const runtimeNotifierWarnLogger = createWarnLogger();
const MAX_ERROR_DIAGNOSTIC_LENGTH = 600;
const MAX_STACK_LINES = 6;

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

  public async notify(runId: string, event: WorkspaceRunEvent): Promise<void> {
    await notifyAll(this.runListeners.get(runId), event);
  }

  public async notifyEntry(entry: EventLogEntry): Promise<void> {
    await notifyAll(this.entryListeners, entry);
    await notifyAll(this.workspaceListeners.get(entry.workspace_id), entry);

    if (entry.run_id !== null) {
      const event = WorkspaceRunEventSchema.safeParse({
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
      runtimeNotifierWarnLogger.warn("[runtime-notifier] listener threw; continuing fan-out", {
        errorName: error instanceof Error ? error.name : "NonError",
        errorMessage: summarizeErrorMessage(error),
        errorStack: summarizeErrorStack(error)
      });
    }
  }
}

function summarizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return sanitizeErrorDiagnostic(error.message);
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return sanitizeErrorDiagnostic(error);
  }
  return "Runtime notifier listener failed.";
}

function summarizeErrorStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string" || error.stack.trim().length === 0) {
    return undefined;
  }
  return sanitizeErrorDiagnostic(error.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n"));
}

function sanitizeErrorDiagnostic(value: string): string {
  let redacted = value;
  redacted = redacted.replace(
    /(["']?authorization["']?\s*[:=]\s*)(?:(["'](?:bearer\s+)?[^"'\r\n]+["'])|((?:bearer\s+)?[^\s"'\r\n,;{}]+))/giu,
    (match, p1, p2, p3) => {
      const p = p2 || p3;
      const isBearer = p.toLowerCase().includes("bearer ");
      const prefix = isBearer ? (p.match(/bearer\s+/i)?.[0] || "Bearer ") : "";
      if (p.startsWith('"') && p.endsWith('"')) {
        return `${p1}"${prefix}[Redacted]"`;
      }
      if (p.startsWith("'") && p.endsWith("'")) {
        return `${p1}'${prefix}[Redacted]'`;
      }
      return `${p1}${prefix}[Redacted]`;
    }
  );
  redacted = redacted.replace(
    /(["']?(?:password|secret)["']?\s*[:=]\s*)(?:(["'][^"'\r\n]+["'])|([^\r\n,;{}]+))/giu,
    (match, p1, p2, p3) => {
      const p = p2 || p3;
      if (p.startsWith('"') && p.endsWith('"')) {
        return `${p1}"[Redacted]"`;
      }
      if (p.startsWith("'") && p.endsWith("'")) {
        return `${p1}'[Redacted]'`;
      }
      return `${p1}[Redacted]`;
    }
  );
  redacted = redacted.replace(
    /(["']?(?:api[_-]?key|token)["']?\s*[:=]\s*)(?:(["'][^"'\r\n]+["'])|([^\s"'\r\n,;{}]+))/giu,
    (match, p1, p2, p3) => {
      const p = p2 || p3;
      if (p.startsWith('"') && p.endsWith('"')) {
        return `${p1}"[Redacted]"`;
      }
      if (p.startsWith("'") && p.endsWith("'")) {
        return `${p1}'[Redacted]'`;
      }
      return `${p1}[Redacted]`;
    }
  );
  if (redacted.length <= MAX_ERROR_DIAGNOSTIC_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_ERROR_DIAGNOSTIC_LENGTH)}...`;
}
