import {
  EngineProvider,
  RunMode,
  RunState,
  SignalKind,
  SignalSource,
  SignalState,
  WorkspaceKind,
  WorkspaceRunEventType
} from "../../index.js";

export function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

export const validTimestamp = "2026-03-15T00:00:00.000Z";
export const invalidTimestamp = "2026-03-15 00:00:00";

export const workspaceBase = {
  workspace_id: "workspace-1",
  name: "Workspace One",
  root_path: "D:/workspace-one",
  workspace_kind: WorkspaceKind.LOCAL_REPO,
  repo_path: null,
  default_engine_binding: null,
  default_engine_class: null,
  workspace_state: "active",
  created_at: validTimestamp,
  archived_at: null
} as const;

export const workspaceEngineConfigBase = {
  workspace_id: "workspace-1",
  default_engine_class: "conversation_engine",
  conversation_binding: {
    provider_type: "custom",
    base_url: "https://proxy.example/v1",
    model: "proxy-model"
  },
  coding_engine_available: true
} as const;

export const runBase = {
  run_id: "run-1",
  workspace_id: "workspace-1",
  title: "Investigate",
  goal: null,
  run_mode: RunMode.CHAT,
  engine_binding_id: null,
  engine_class: null,
  run_state: RunState.IDLE,
  current_surface_id: null,
  created_at: validTimestamp,
  last_active_at: "2026-03-15T00:05:00.000Z"
} as const;

export const eventLogEntryBase = {
  event_id: "event-1",
  event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
  entity_type: "workspace",
  entity_id: "workspace-1",
  workspace_id: "workspace-1",
  run_id: null,
  caused_by: null,
  revision: 0,
  payload_json: {
    workspace_id: "workspace-1",
    name: "Workspace One",
    workspace_kind: WorkspaceKind.LOCAL_REPO
  },
  created_at: validTimestamp
} as const;

export const engineBindingInputBase = {
  provider_type: EngineProvider.OPENAI,
  base_url: null,
  api_key: "sk-openai",
  model: "gpt-4o-mini",
  config: {}
} as const;

export const candidateMemorySignalBase = {
  signal_id: "signal-1",
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  source: SignalSource.MODEL_TOOL,
  signal_kind: SignalKind.POTENTIAL_SYNTHESIS,
  signal_state: SignalState.EMITTED,
  object_kind: "working_note",
  scope_hint: null,
  domain_tags: ["repo", "planning"],
  confidence: 0.75,
  evidence_refs: ["message-1", "message-2"],
  source_memory_refs: [],
  supersedes_refs: [],
  exception_to_refs: [],
  contradicts_refs: [],
  incompatible_with_refs: [],
  raw_payload: {
    summary: "Potential synthesis candidate",
    message_ids: ["message-1", "message-2"]
  },
  created_at: validTimestamp
} as const;

export const candidateMemorySignalInputBase = {
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  signal_kind: SignalKind.POTENTIAL_CLAIM,
  object_kind: "constraint",
  scope_hint: null,
  domain_tags: ["security"],
  confidence: 0.5,
  evidence_refs: ["message-1"],
  raw_payload: {
    excerpt: "Do not expose secrets."
  }
} as const;

export const emitCandidateSignalResponseBase = {
  signal_id: "signal-1",
  status: "emitted"
} as const;
