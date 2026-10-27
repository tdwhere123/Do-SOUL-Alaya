import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../harness/daemon.js";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";

it("exposes the current field protocol over real daemon MCP without a private comparison execution handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "alaya-public-library-")), clock = "2026-10-21T00:00:00.000Z";
  const request = { operation: "recall" as const, accepts_unreviewed_conditional_results: true as const,
    original_query: "synthetic empty corpus", semantic_correspondences: [], authorized_scopes: { mode: "named", scopes: ["project"] },
    budget: { schema_version: 1, work_units: 200000, memory_bytes: 4000000, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 },
    output_byte_limit: 19392 };
  try {
    const daemon = await startBenchDaemon({ dataDirRoot: join(root, "data"), configDirectoryRoot: root,
      workspaceId: "actual-public-workspace", runId: "actual-public-run", gardenCompute: "disabled", sqliteWriteQueue: "disabled",
      embeddingStartupProbe: "omit", sourceSemanticInterpretationClock: clock, sourceSemanticObservations: true });
    try {
      const mcp = vi.spyOn(daemon.mcpClient, "callTool");
      const observed = await daemon.observeSourceSemantics!({}, () => callMcpTool(daemon.mcpClient, "soul.interpretation", request));
      if (observed.outcome.status === "failure") throw observed.outcome.error;
      expect(mcp).toHaveBeenCalledTimes(1);
      const ordinary = SoulInterpretationResponseSchema.parse(observed.outcome.value);
      expect(ordinary).toMatchObject({ operation: "recall", protocol_version: 12,
        index: { result_version: "ordinary-native-field.v5" } });
      expect(observed.status).toBe("available");
      expect(observed.observations).toHaveLength(2);
      expect(observed.observations[1]).toMatchObject({ execution: "success", status: "observed",
        events: [{ kind: "delivery_settlement", phase: "delivery", data: {
          execution_receipt: { schema_version: 1 }
        } }] });
      expect(observed.observations[0]!.facts?.binding).toMatchObject({ workspace_id: daemon.workspaceId, as_of: clock });
      expect(daemon).not.toHaveProperty("compareSourceSemantics");
      expect(daemon.runtime).not.toHaveProperty("sourceSemanticsPort");
      await expect(callMcpTool(daemon.mcpClient, "soul.interpretation", { ...request, candidate_profile: {} })).rejects.toThrow();
    } finally { await daemon.shutdown(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
