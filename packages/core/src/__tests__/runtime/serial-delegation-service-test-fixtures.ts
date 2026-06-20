import { vi } from "vitest";
import type { AgentRuntimePort, DelegatedWorkerRun, RuntimeCancelResult, RuntimeCapabilities, RuntimeEvent, RuntimeSession, RuntimeSessionConfig } from "@do-soul/alaya-protocol";
import { type DispatchWorkerInput } from "../../runtime/serial-delegation-service.js";

import { FIXED_NOW, FIXED_WORKER_RUN_ID } from "./serial-delegation-service-harness-fixtures.js";

export {
  FIXED_NOW,
  FIXED_WORKER_RUN_ID,
  createHarness,
  createIntegrationDecision,
  createWorkerBaselineLock,
  type ClearSessionStateMock,
  type HarnessOptions,
  type RuntimeNormalizeMock,
  type RuntimeNormalizerContext
} from "./serial-delegation-service-harness-fixtures.js";

export function createManualRuntimeAdapter(options: {
  readonly prompt?: (
    sessionId: string,
    input: { readonly prompt: string },
    emit: (event: RuntimeEvent) => void
  ) => Promise<void>;
  readonly cancel?: (
    sessionId: string,
    emit: (event: RuntimeEvent) => void
  ) => Promise<RuntimeCancelResult>;
} = {}): {
  readonly adapter: AgentRuntimePort;
  emit(event: RuntimeEvent): void;
} {
  const handlers = new Set<(event: RuntimeEvent) => void>();
  const session: RuntimeSession = { session_id: "scripted-session-1" };
  const capabilities: RuntimeCapabilities = {
    supports_resume: false,
    supports_interrupt: true,
    supports_streaming_updates: true,
    supports_tool_events: true,
    supports_permission_requests: true,
    supports_artifact_events: false,
    supports_terminal_events: false
  };

  return {
    adapter: {
      kind: "manual_runtime",
      getCapabilities: () => capabilities,
      createSession: vi.fn(async (_config: RuntimeSessionConfig) => session),
      prompt: vi.fn(
        async (sessionId: string, input: { readonly prompt: string }) =>
          await options.prompt?.(sessionId, input, (event) => {
            for (const handler of handlers) {
              handler(event);
            }
          })
      ),
      cancel: vi.fn(
        async (sessionId: string): Promise<RuntimeCancelResult> =>
          (await options.cancel?.(sessionId, (event) => {
            for (const handler of handlers) {
              handler(event);
            }
          })) ?? {
            session_id: sessionId,
            status: "already_finished"
          }
      ),
      onEvent: (handler: (event: RuntimeEvent) => void) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      }
    },
    emit(event: RuntimeEvent) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  };
}

export function createDispatchInput(overrides: Partial<DispatchWorkerInput> = {}): DispatchWorkerInput {
  return {
    principalRunId: "principal-run-1",
    workspaceId: "ws-serial-delegation",
    engineClass: "coding_engine",
    subtaskDescription: "Audit the failing worker path.",
    localSurfaceRef: "surface://principal/1",
    localEvidencePointer: "evidence://principal/1",
    restrictedToolSet: ["read_file", "exec_shell"],
    localBudget: {
      max_worker_delegations: 1,
      max_tool_calls: 4,
      max_output_tokens: 2048,
      max_wall_time_ms: 120000
    },
    agreedReturnFormat: {
      allowed_return_kinds: ["analysis_note", "verification_result"],
      requires_structured_summary: true
    },
    principalSecuritySnapshot: {
      governance_lease_ref: "lease://principal/1",
      hard_constraint_refs: ["constraint://1"],
      denied_tool_categories: ["network"]
    },
    sessionConfig: createSessionConfig(),
    prompt: "Investigate the failure and report the cause.",
    ...overrides
  };
}

export function createSessionConfig(): RuntimeSessionConfig {
  return {
    role: "worker",
    workspace_id: "ws-serial-delegation",
    run_id: "principal-run-1",
    cwd: "/workspace",
    writable_roots: ["/workspace"],
    tool_profile: "coding",
    allowed_mcp_servers: ["github"],
    sandbox_policy: "workspace_write",
    permission_policy: "ask",
    network_policy: "restricted"
  };
}

export function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: overrides.worker_run_id ?? FIXED_WORKER_RUN_ID,
    principal_run_id: overrides.principal_run_id ?? "principal-run-1",
    workspace_id: overrides.workspace_id ?? "ws-serial-delegation",
    requesting_run_id: overrides.requesting_run_id ?? "principal-run-1",
    engine_class: overrides.engine_class ?? "coding_engine",
    state: overrides.state ?? "init",
    subtask_description: overrides.subtask_description ?? "Audit the failing worker path.",
    local_surface_ref: overrides.local_surface_ref ?? "surface://principal/1",
    local_evidence_pointer: overrides.local_evidence_pointer ?? "evidence://principal/1",
    restricted_tool_set: overrides.restricted_tool_set ?? ["read_file", "exec_shell"],
    local_budget:
      overrides.local_budget ?? {
        max_worker_delegations: 1,
        max_tool_calls: 4,
        max_output_tokens: 2048,
        max_wall_time_ms: 120000
      },
    agreed_return_format:
      overrides.agreed_return_format ?? {
        allowed_return_kinds: ["analysis_note", "verification_result"],
        requires_structured_summary: true
      },
    principal_security_snapshot:
      overrides.principal_security_snapshot ?? {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: ["constraint://1"],
        denied_tool_categories: ["network"]
      },
    created_at: overrides.created_at ?? FIXED_NOW,
    updated_at: overrides.updated_at ?? FIXED_NOW
  };
}

export function messageDeltaEvent(delta: string, sequence: number): RuntimeEvent {
  return {
    type: "message_delta",
    session_id: "session-1",
    emitted_at: "2026-04-13T11:00:01.000Z",
    delta,
    sequence
  };
}

export function sessionFinishedEvent(
  status: "completed" | "cancelled" | "failed",
  resultSummary: string | null
): RuntimeEvent {
  return {
    type: "session_finished",
    session_id: "session-1",
    emitted_at: "2026-04-13T11:00:02.000Z",
    status,
    result_summary: resultSummary
  };
}

export async function flushAsync(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

export async function flushTimerTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function flushRecoveryGracePeriod(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await flushAsync();
  await flushAsync();
  await flushAsync();
}
