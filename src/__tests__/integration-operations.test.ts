import { describe, expect, it, vi } from "vitest";
import {
  integrationOperationDescriptors,
  invokeIntegrationOperation,
  type AlayaIntegrationRuntimeBoundary
} from "../integration/index.js";
import type { AuditedRecallContextInput } from "../runtime/types.js";

describe("integration operation descriptors", () => {
  it("declares current runtime-facing operations with capability and strictness metadata", () => {
    expect(integrationOperationDescriptors.map((descriptor) => descriptor.operationId)).toEqual([
      "assemble_recall_context",
      "record_context_pack",
      "select_provider",
      "record_proposal",
      "record_memory_session_event",
      "generate_trust_summary",
      "doctor"
    ]);

    for (const descriptor of integrationOperationDescriptors) {
      expect(descriptor.capability).toEqual(expect.any(String));
      expect(descriptor.strictness.runtimeBoundary).toBe("AlayaRuntimePort");
      expect(descriptor.strictness.governanceBoundary).toBe("runtime");
      expect(descriptor.durableTruthProduced).toBe(false);
    }

    expect(
      integrationOperationDescriptors.find(
        (descriptor) => descriptor.operationId === "select_provider"
      )?.strictness
    ).toMatchObject({
      mode: "fail_closed_capable",
      strictActivation: "explicit_only"
    });
  });

  it("invokes an injected runtime operation boundary", async () => {
    const input: AuditedRecallContextInput = {
      budget: {
        max_items: 2,
        max_tokens: 200
      },
      evidence: [
        {
          kind: "test",
          ref: "integration-operations.test"
        }
      ],
      query: {
        limit: 2,
        query_text: "runtime boundary",
        run_id: "run-1",
        workspace_id: "workspace-1"
      },
      source: {
        kind: "test",
        ref: "integration-operations.test"
      }
    };
    const expected = {
      committed: true,
      mutationId: "mutation-context",
      notification: "not_requested",
      result: {
        budget: input.budget,
        degradations: [],
        delivery_metadata: {
          counts_as_usage_proof: false,
          delivered_candidate_count: 0,
          excluded_candidate_count: 0
        },
        delivery_text: "",
        durable_truth: false,
        excluded: [],
        included: [],
        pack_id: "pack-1",
        source_planes: [],
        total_token_estimate: 0,
        workspace_id: input.query.workspace_id
      }
    } as const;
    const runtime = {
      assembleRecallContext: vi.fn(async () => expected)
    } as unknown as AlayaIntegrationRuntimeBoundary;

    await expect(
      invokeIntegrationOperation(runtime, "assemble_recall_context", input)
    ).resolves.toBe(expected);
    expect(runtime.assembleRecallContext).toHaveBeenCalledExactlyOnceWith(input);
  });
});
