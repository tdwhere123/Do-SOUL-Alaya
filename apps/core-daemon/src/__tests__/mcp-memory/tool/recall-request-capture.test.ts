import { expect, it, vi } from "vitest";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { capableRecallRequest, context, createDeps } from "./mcp-memory-tool-handler-fixture.js";

it.each([false, true])("captures ordinary query, scope and continuation before admission (continuation=%s)", async continued => {
  const deps = createDeps();
  const continuation = { schema_version: 1 as const, continuation_id: "original-continuation",
    query_id: `sha256:${"a".repeat(64)}`, snapshot_id: `sha256:${"b".repeat(64)}`, result_version: "v1",
    expires_at: "2099-01-01T00:00:00.000Z", cursor: "original-cursor", authorized_scopes: ["project"] };
  const args = capableRecallRequest({ query: "original needle", dimension: null, domain_tags: null,
    max_results: 5, scope_class: "project" as string | null, ...(continued ? { continuation } : {}) });
  const principal = { ...context };
  const recall = vi.fn(async () => { throw new Error("stop after observing service input"); });
  const handler = createMcpMemoryToolHandler({ ...deps, recallService: { recall },
    zeroDayToolAccess: { enforceToolAccess: async () => {
      args.query = "changed"; args.scope_class = null;
      continuation.cursor = "changed"; continuation.authorized_scopes.push("global_domain");
      principal.workspaceId = "foreign";
      await Promise.resolve();
    } } });
  await handler.call({ toolName: "soul.recall", arguments: args, context: principal });
  expect(recall).toHaveBeenCalledWith(expect.objectContaining({ queryText: "original needle", workspaceId: context.workspaceId,
    policyOverride: expect.objectContaining({ coarse_filter: expect.objectContaining({ deterministic_match:
      expect.objectContaining({ scope_filter: ["project"] }) }) }),
    ...(continued ? { continuation: expect.objectContaining({ cursor: "original-cursor", authorized_scopes: ["project"] }) } : {}) }));
  expect(args.query).toBe("changed");
  expect(Object.isFrozen(args)).toBe(false);
  expect(Object.isFrozen(continuation)).toBe(false);
});

it("keeps caller cancellation live while ordinary admission is awaiting", async () => {
  const controller = new AbortController(), deps = createDeps();
  const handler = createMcpMemoryToolHandler({ ...deps, zeroDayToolAccess: { enforceToolAccess: async () => {
    await Promise.resolve(); controller.abort(new Error("caller cancelled"));
  } } });
  const result = await handler.call({ toolName: "soul.recall", arguments: capableRecallRequest({ query: "needle",
    dimension: null, domain_tags: null, scope_class: "project", max_results: 5 }),
    context: { ...context, abortSignal: controller.signal } });
  expect(result.ok).toBe(false);
  expect(deps.recallService.recall).not.toHaveBeenCalled();
});
