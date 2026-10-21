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
import { SoulInterpretationResponseSchema, type SourceSemanticAccessProfile } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../harness/daemon.js";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { capturePrivateSourceLibrary, admitPrivateSourceLibraryCapture } from "../../runs/recall-measurement/private-library-capture.js";

it("binds the real daemon handler and enclosed bench context without manufacturing MCP calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "alaya-private-comparison-")), clock = "2026-10-21T00:00:00.000Z";
  const profile: SourceSemanticAccessProfile = { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7",
    protocol_version: 9, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
    channels: "lexical", declared_allowance: { max_attempts: 32, max_roots: 18, max_vector_windows: 0 } };
  const request = { operation: "recall" as const, accepts_unreviewed_conditional_results: true as const,
    original_query: "synthetic empty corpus", semantic_correspondences: [], authorized_scopes: { mode: "named", scopes: ["project"] },
    budget: { schema_version: 1, work_units: 200000, memory_bytes: 4000000, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 },
    output_byte_limit: 19392 };
  try {
    const daemon = await startBenchDaemon({ dataDirRoot: join(root, "data"), configDirectoryRoot: root,
      workspaceId: "actual-private-workspace", runId: "actual-private-run", gardenCompute: "disabled", sqliteWriteQueue: "disabled",
      embeddingStartupProbe: "omit", sourceSemanticInterpretationClock: clock, sourceSemanticComparison: true, sourceSemanticObservations: true });
    try {
      const mcp = vi.spyOn(daemon.mcpClient, "callTool");
      const observed = await daemon.observeSourceSemantics!({}, () => capturePrivateSourceLibrary({ daemon, request, profile, maxPages: 2 }));
      if (observed.outcome.status === "failure") throw observed.outcome.error;
      const capture = observed.outcome.value;
      expect(mcp).not.toHaveBeenCalled();
      expect(capture.pages).toHaveLength(1);
      expect(capture.pages[0]!.context).toMatchObject({ workspace_id: daemon.workspaceId, run_id: daemon.runId, agent_target: "bench-runner" });
      expect(capture.pages[0]!.context.session_id).toMatch(/^bench-session-/u);
      expect(observed.status).toBe("available");
      expect(observed.observations).toHaveLength(1);
      expect(admitPrivateSourceLibraryCapture(JSON.parse(JSON.stringify(capture)), { workspace_id: daemon.workspaceId,
        run_id: daemon.runId, as_of: clock, request, profile, verifySources: () => [] }).status).toBe("admitted");
      const ordinary = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation", request));
      expect(ordinary.operation).toBe("recall");
      if (ordinary.operation !== "recall") throw new Error("expected public library recall");
      expect(ordinary.protocol_version).toBe(8);
      expect(ordinary.index?.result_version).toBe("source-semantic-library-v6");
      expect(daemon.runtime).not.toHaveProperty("sourceSemanticsPort");
      await expect(callMcpTool(daemon.mcpClient, "soul.interpretation", { ...request, candidate_profile: profile })).rejects.toThrow();
    } finally { await daemon.shutdown(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
