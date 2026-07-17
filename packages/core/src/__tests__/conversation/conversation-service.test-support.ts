import { vi } from "vitest";
import { RunMode, RunState, WorkspaceKind, WorkspaceState, type CandidateMemorySignal, type ContextLens, type ConversationMessage, type EventLogEntry, type Run, type Workspace, type WorkingProjection } from "@do-soul/alaya-protocol";
import { ConversationService, type ConversationServiceDependencies } from "../../conversation/conversation-service.js";

export function createService(
  overrides: Partial<ConversationServiceDependencies> = {}
): {
  readonly service: ConversationService;
  readonly dependencies: ConversationServiceDependencies;
} {
  const run = createRun();
  const workspace = createWorkspace();
  const dependencies = {
    runRepo: {
      getById: vi.fn(async (runId: string) => (runId === run.run_id ? run : null))
    },
    workspaceRepo: {
      getById: vi.fn(async (workspaceId: string) => (workspaceId === workspace.workspace_id ? workspace : null))
    },
    eventLogRepo: {
      queryConversationMessageEventsByRun: vi.fn(async () => []),
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
        event_id: "event-1",
        created_at: "2026-04-29T00:00:00.000Z",
        revision: 0,
        ...entry
      }))
    },
    gardenComputeProvider: {
      provider_kind: "local_heuristics" as const,
      compile: vi.fn(async () => [])
    },
    signalReceiver: {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({
        signal,
        triage_result: "dropped" as const,
        materialization: null
      }))
    },
    warn: vi.fn(),
    ...overrides
  } satisfies ConversationServiceDependencies;

  return {
    service: new ConversationService(dependencies),
    dependencies
  };
}

export function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "Run title",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: "conversation_engine",
    run_state: RunState.IDLE,
    current_surface_id: "surface://cli/main",
    created_at: "2026-04-29T00:00:00.000Z",
    last_active_at: "2026-04-29T00:00:00.000Z",
    ...overrides
  };
}

export function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    repo_path: null,
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE,
    created_at: "2026-04-29T00:00:00.000Z",
    archived_at: null,
    ...overrides
  };
}

export function createContextLens(): ContextLens {
  return {
    runtime_id: "lens-runtime-1",
    object_kind: "context_lens",
    task_surface_ref: "task-surface-runtime-1",
    expires_at: "2026-04-29T01:00:00.000Z",
    derived_from: "task-surface-runtime-1",
    retention_policy: "session_only",
    lens_entries: [
      {
        object_id: "memory-1",
        object_kind: "memory_entry",
        relevance_score: 0.9,
        manifestation: "full_eligible",
        scope_class: "project"
      }
    ],
    not_a_priority_source: true
  };
}

export function createWorkingProjection(): WorkingProjection {
  return {
    runtime_id: "projection-runtime-1",
    object_kind: "working_projection",
    task_surface_ref: "task-surface-runtime-1",
    expires_at: "2026-04-29T01:00:00.000Z",
    derived_from: "lens-runtime-1",
    retention_policy: "session_only",
    entries: [
      {
        object_id: "memory-1",
        object_kind: "memory_entry",
        content_snapshot: "Use explicit evidence before durable memory.",
        token_estimate: 11
      }
    ],
    total_token_estimate: 11,
    recall_policy_ref: "recall-policy-runtime-1"
  };
}

export function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface://cli/main",
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["memory"],
    confidence: 0.8,
    evidence_refs: ["msg-user"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      excerpt: "Use explicit evidence before durable memory."
    },
    source_observation: null,
    created_at: "2026-04-29T00:00:00.000Z",
    ...overrides
  };
}

export function createMessage(
  messageId: string,
  role: ConversationMessage["role"],
  content: string
): ConversationMessage {
  return {
    message_id: messageId,
    role,
    content
  };
}

export async function flushBackgroundTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
