import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  RuntimeGovernanceEventType,
  ScopeClass
} from "@do-soul/alaya-protocol";
import {
  MEM_A,
  MEM_B,
  MEM_C,
  createHarness,
  reportUsed
} from "./recall-cross-link-fixture.js";

describe("recall usage: report_context_usage(used) does not mint ungoverned RECALLS", () => {

  it("does not queue ungoverned RECALLS proposals from a used report", async () => {
    const harness = await createHarness([MEM_A, MEM_B, MEM_C], { realEdgeProposals: true });

    await reportUsed(harness, [MEM_A, MEM_B]);

    expect(await harness.pathRelationRepo.findByWorkspace("workspace-1")).toEqual([]);
    expect(harness.edgeProposalRepo.listPending("workspace-1")).toEqual([]);
    expect(harness.graphEdgePort.createEdge).not.toHaveBeenCalled();
  });
});

describe("recall usage: legacy graph edge behavior stays disconnected", () => {

  it("records the report without invoking a throwing graph edge port", async () => {
    const harness = await createHarness([MEM_A, MEM_B]);
    harness.graphEdgePort.createEdge.mockRejectedValueOnce(new Error("edge db down"));

    const result = await reportUsed(harness, [MEM_A, MEM_B]);

    expect(result).toMatchObject({ ok: true });
    expect(harness.graphEdgePort.createEdge).not.toHaveBeenCalled();
  });
});

describe("recall usage: delivery never accrues co-recall plasticity", () => {

  it("does not schedule delivery-based co-recall even when the seeder would fail", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => true);
    const harness = await createHarness([MEM_A, MEM_B], {
      recallCandidateIds: [MEM_A, MEM_B],
      coRecallCoherenceGate: {
        coherentPairKeys: vi.fn(async () => new Set([`${MEM_A}|${MEM_B}`]))
      }
    });

    try {
      const result = await harness.handler.call({
        toolName: "soul.recall",
        arguments: {
          protocol_version: 1,
          supported_result_kinds: ["memory_entry", "source_evidence"],
          supports_source_evidence: true,
          supports_product_updates: true,
          query: "coffee",
          scope_class: ScopeClass.PROJECT,
          dimension: MemoryDimension.PREFERENCE,
          domain_tags: ["recall"],
          max_results: 2
        },
        context: {
          workspaceId: "workspace-1",
          runId: "run-1",
          agentTarget: "cli",
          sessionId: "recall-cross-link-session"
        }
      });

      expect(result).toMatchObject({ ok: true });
      const events = await harness.eventLogRepo.queryByWorkspaceAndType(
        "workspace-1",
        RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED
      );
      expect(events).toEqual([]);
      expect(emitWarning).not.toHaveBeenCalledWith(
        "[RecallUsage] co-recall plasticity side effect failed",
        expect.anything()
      );
    } finally {
      emitWarning.mockRestore();
    }
  });
});
