import { describe, expect, it, vi } from "vitest";
import {
  ComputeProviderPriority,
  PhaseCEventType,
  type EventLogEntry,
  type ExecutionStanceResolution
} from "@do-soul/alaya-protocol";
import { createComputeRoutingExecutionStanceResolver } from "../compute-routing-resolver.js";

const NOW = "2026-04-17T10:20:30.000Z";

describe("createComputeRoutingExecutionStanceResolver", () => {
  it("appends compute.provider_routed after stance resolution succeeds", async () => {
    const route = vi.fn(async () => ({
      decision_id: "decision-001",
      workspace_id: "workspace-1",
      selected_provider: ComputeProviderPriority.STUB,
      model_id: "local-heuristics",
      adapter: "garden.local_heuristics",
      selection_reason: "stub selected as configured fallback compute provider",
      decided_at: NOW
    }));
    const toModelRef = vi.fn(() => ({
      provider: "stub",
      model_id: "local-heuristics",
      adapter: "garden.local_heuristics"
    }));
    const append = vi.fn(
      async (
        entry: Omit<EventLogEntry, "event_id" | "created_at">
      ): Promise<EventLogEntry> => ({
        event_id: "event-1",
        created_at: NOW,
        ...entry
      })
    );
    const resolve = vi.fn(
      async (): Promise<ExecutionStanceResolution> => ({
        resolution_id: "resolution-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        verification_attention: "standard",
        conservatism: "balanced",
        contributing_candidate_ids: [],
        model_ref: {
          provider: "stub",
          model_id: "local-heuristics",
          adapter: "garden.local_heuristics"
        },
        resolved_at: NOW
      })
    );

    const resolver = createComputeRoutingExecutionStanceResolver({
      computeRoutingService: {
        route,
        toModelRef
      },
      eventLogWriter: {
        append
      },
      stanceResolutionService: {
        resolve
      }
    });

    await resolver.resolve({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [],
      modelRef: null
    });

    expect(route).toHaveBeenCalledWith("workspace-1");
    expect(append).toHaveBeenCalledWith({
      event_type: PhaseCEventType.COMPUTE_PROVIDER_ROUTED,
      entity_type: "compute_provider_route",
      entity_id: "decision-001",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "deterministic_rule",
      revision: 0,
      payload_json: {
        decision_id: "decision-001",
        workspace_id: "workspace-1",
        selected_provider: "stub",
        model_id: "local-heuristics",
        selection_reason: "stub selected as configured fallback compute provider",
        decided_at: NOW
      }
    });
    expect(resolve).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [],
      modelRef: {
        provider: "stub",
        model_id: "local-heuristics",
        adapter: "garden.local_heuristics"
      }
    });
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(append.mock.invocationCallOrder[0]);
  });

  it("does not append compute.provider_routed when stance resolution fails", async () => {
    const append = vi.fn();
    const resolver = createComputeRoutingExecutionStanceResolver({
      computeRoutingService: {
        route: vi.fn(async () => ({
          decision_id: "decision-001",
          workspace_id: "workspace-1",
          selected_provider: ComputeProviderPriority.STUB,
          model_id: "local-heuristics",
          adapter: "garden.local_heuristics",
          selection_reason: "stub selected as configured fallback compute provider",
          decided_at: NOW
        })),
        toModelRef: vi.fn(() => ({
          provider: "stub",
          model_id: "local-heuristics",
          adapter: "garden.local_heuristics"
        }))
      },
      eventLogWriter: { append },
      stanceResolutionService: {
        resolve: vi.fn(async () => {
          throw new Error("stance resolution failed");
        })
      }
    });

    await expect(
      resolver.resolve({
        workspaceId: "workspace-1",
        runId: "run-1",
        candidates: [],
        modelRef: null
      })
    ).rejects.toThrow("stance resolution failed");
    expect(append).not.toHaveBeenCalled();
  });
});
