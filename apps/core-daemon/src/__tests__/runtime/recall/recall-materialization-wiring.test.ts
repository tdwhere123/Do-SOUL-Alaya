import { describe, expect, it, vi } from "vitest";
import { recallMaterializationWiringTestInternals } from "../../../runtime/recall-materialization/recall-materialization-wiring.js";
import { recallMaterializationRecallRuntimeTestInternals } from "../../../runtime/recall-materialization/recall-materialization-recall-runtime.js";
import { createRecallPathReadPorts } from "../../../runtime/recall/recall-path-readers.js";

const { closeRecallReadWorkerAfterStartupFailure } = recallMaterializationWiringTestInternals;
const { createRecallGraphSupportPort } = recallMaterializationRecallRuntimeTestInternals;

describe("createRecallMaterializationWiring startup cleanup", () => {
  it("closes a started recall read worker and rethrows the original startup error", async () => {
    const startupError = new Error("config unavailable");
    const close = vi.fn(async () => undefined);
    const warn = vi.fn();

    await expect(
      closeRecallReadWorkerAfterStartupFailure({
        recallReadWorkerClient: { close },
        warn,
        error: startupError
      })
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on worker cleanup failure while preserving the startup error", async () => {
    const startupError = new Error("startup failed");
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    const warn = vi.fn();

    await expect(
      closeRecallReadWorkerAfterStartupFailure({
        recallReadWorkerClient: { close },
        warn,
        error: startupError
      })
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "recall read worker startup cleanup failed",
      expect.objectContaining({ error: "close failed" })
    );
  });

  it("feeds governed soft associations into forced-legacy graph metrics", async () => {
    const softPath = createSoftPath();
    const readPorts = createRecallPathReadPorts({
      legacyPathReader: {
        findByAnchors: vi.fn(async () => []),
        findByWorkspaceAll: vi.fn(async () => []),
        findActiveAll: vi.fn(async () => [])
      },
      softAssociationPathReader: {
        findByAnchors: vi.fn(async () => [softPath]),
        findActiveByWorkspace: vi.fn(async () => [softPath])
      }
    });
    const graph = createRecallGraphSupportPort({ eventLogRepo: {} as never }, readPorts);

    await expect(graph.countInboundRecalls("memory-target", "workspace-1"))
      .resolves.toBe(1);
  });
});

function createSoftPath() {
  return {
    path_id: "soft-path",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object" as const, object_id: "memory-source" },
      target_anchor: { kind: "object" as const, object_id: "memory-target" }
    },
    constitution: {
      relation_kind: "co_recalled",
      why_this_relation_exists: ["earned co-recall"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry" as const
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "source_to_target" as const,
      stability_class: "stable" as const,
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-08-15T00:00:00.000Z"
    },
    lifecycle: { status: "active" as const, retirement_rule: "manual" },
    legitimacy: {
      evidence_basis: ["recalls_edge_co_usage"],
      governance_class: "attention_only" as const
    },
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z"
  };
}
