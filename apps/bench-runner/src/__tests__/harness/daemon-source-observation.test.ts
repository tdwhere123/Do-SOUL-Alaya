import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../harness/daemon.js";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";

describe("bench private source observation binding", () => {
  it("remains absent without startup opt-in", async () => {
    const root = mkdtempSync(join(tmpdir(), "bench-observation-disabled-"));
    try {
      const daemon = await startBenchDaemon({ dataDirRoot: join(root, "data"), configDirectoryRoot: root,
        gardenCompute: "disabled", sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit" });
      try { expect(daemon.observeSourceSemantics).toBeUndefined(); }
      finally { await daemon.shutdown(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("joins the compiled startup registry to a real MCP worker request without changing the public envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "bench-observation-enabled-"));
    try {
      const daemon = await startBenchDaemon({ dataDirRoot: join(root, "data"), configDirectoryRoot: root,
        gardenCompute: "disabled", sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit",
        sourceSemanticObservations: true, sourceSemanticInterpretationClock: "2026-10-19T00:00:00.000Z" });
      try {
        expect(daemon.observeSourceSemantics).toBeTypeOf("function");
        const captured = await daemon.observeSourceSemantics!({}, () => callMcpTool(daemon.mcpClient,
          "soul.interpretation", { operation: "recall", accepts_unreviewed_conditional_results: true,
            original_query: "source observation", semantic_correspondences: [],
            budget: { schema_version: 1, work_units: 200_000, memory_bytes: 4_000_000,
              page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 }, output_byte_limit: 176_340,
            authorized_scopes: { mode: "named", scopes: ["project"] } }));
        if (captured.outcome.status === "failure") throw captured.outcome.error;
        expect(SoulInterpretationResponseSchema.safeParse(captured.outcome.value).success).toBe(true);
        expect(captured.outcome.value).not.toHaveProperty("observations");
        expect(captured.status).toBe("available");
        expect(captured.observations).toHaveLength(1);
        expect(captured.observations[0]).toMatchObject({ version: 1, execution: "success", status: "observed" });
        expect(captured.observations[0]!.meters.length).toBeGreaterThan(0);
      } finally { await daemon.shutdown(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
