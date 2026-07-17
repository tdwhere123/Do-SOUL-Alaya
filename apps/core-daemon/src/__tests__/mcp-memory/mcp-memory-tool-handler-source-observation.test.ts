import { describe, expect, it, vi } from "vitest";
import { createMcpMemoryToolHandler } from "../../mcp-memory/tool-handler.js";
import {
  context,
  createDeliveryRecord,
  createDeps
} from "./mcp-memory-tool-handler-fixture.js";

describe("mcp memory tool handler source observation", () => {
  it("derives the explicit candidate receipt from a verified delivery instead of client input", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async (deliveryId: string) =>
      createDeliveryRecord(deliveryId)
    );
    const handler = createMcpMemoryToolHandler(deps);

    await expect(
      handler.call({
        toolName: "soul.emit_candidate_signal",
        arguments: {
          signal_kind: "potential_preference",
          object_kind: "memory_entry",
          scope_hint: "project",
          domain_tags: ["tooling"],
          confidence: 0.9,
          evidence_refs: ["memory-1"],
          raw_payload: { observation: "Use pnpm." },
          source_delivery_ids: ["delivery-1"]
        },
        context
      })
    ).resolves.toMatchObject({ ok: true });

    expect(deps.signalService.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        source_observation: {
          observed_at: "2026-04-30T00:00:00.000Z",
          authority: "verified_delivery_observation",
          source_event_id: "event-delivery-1"
        }
      })
    );
  });

  it("rejects a client-provided explicit source timestamp", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    await expect(
      handler.call({
        toolName: "soul.emit_candidate_signal",
        arguments: {
          signal_kind: "potential_preference",
          object_kind: "memory_entry",
          scope_hint: "project",
          domain_tags: ["tooling"],
          confidence: 0.9,
          evidence_refs: ["memory-1"],
          raw_payload: { observation: "Use pnpm." },
          source_observed_at: "1999-01-01T00:00:00.000Z"
        },
        context
      })
    ).resolves.toMatchObject({ ok: false });

    expect(deps.signalService.receiveSignal).not.toHaveBeenCalled();
  });
});
