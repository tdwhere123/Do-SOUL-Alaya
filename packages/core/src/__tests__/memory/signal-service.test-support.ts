import { vi } from "vitest";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type { SignalServiceDependencies } from "../../memory/signal-service-types.js";

export function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  const { signal_state, ...restOverrides } = overrides;

  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: signal_state ?? "emitted",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.5,
    evidence_refs: ["msg-1"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      excerpt: "Never print secrets."
    },
    source_observation: null,
    created_at: "2026-03-18T00:00:00.000Z",
    ...restOverrides
  };
}

export function signalServiceDependencies(
  overrides: Partial<SignalServiceDependencies> = {}
): SignalServiceDependencies {
  return {
    eventLogRepo: {
      append: vi.fn(),
      queryByEntity: vi.fn(async () => [])
    },
    signalRepo: {
      create: vi.fn(),
      getById: vi.fn(async () => null),
      listByRun: vi.fn(async () => []),
      updateState: vi.fn()
    },
    runtimeNotifier: {
      notifyEntry: vi.fn()
    },
    ...overrides
  };
}
