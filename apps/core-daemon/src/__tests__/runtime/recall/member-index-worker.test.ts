import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { fixture as storageFixture } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishMessages, publishStatement } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { MEMBER_INDEX_ROOTS, clipUtf8 } from "../../../runtime/recall-read-worker/member-index.js";
import { CLOCK, WS, withIndexedSources, SIMULATED_CONFIGURATION } from "./source-semantic-index-acquisition.test-support.js";

// More roots than the 16-root pool: the overflow is listed, never nominated.
const sources = Array.from({ length: 24 }, (_, index) => ({ id: `root-${String(index).padStart(2, "0")}`,
  message: `needle event ${index}: ${"detail ".repeat(index % 3 === 0 ? 60 : 3)}`.trim(),
  eventTime: `2020-01-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00.000Z`, vector: [1, 0, 0] }))
  .map(source => ({ ...source, text: `user: ${source.message}\n` }));
const withStatement = (id: string) => Number(id.slice(-2)) % 2 === 0;

it("lists further members once on the first page through real SQLite, built Worker and MCP", async () => {
  await withIndexedSources(sources, async fixture => {
    const client = await fixture.openClient(), service = new RecallService({ ...createDependencies().dependencies,
      now: () => CLOCK, readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const call = async (extra: object) => {
      const output = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query: "needle", max_results: 5, scope_class: "project", dimension: null, domain_tags: null,
        result_kind_view: "source_only", ...extra }, context: { workspaceId: WS, runId: "run-1",
        sessionId: "member-index-session", agentTarget: "codex" } });
      if (!output.ok) throw new Error(JSON.stringify(output.error));
      return SoulMemorySearchResponseSchema.parse(output.output);
    };
    const first = await call({});
    const root = (target: { kind: string; root_id?: string }) => target.kind === "source_evidence" ? target.root_id! : "memory";
    const delivered = first.index!.entries.map(entry => root(entry.target));
    const lines = first.member_index ?? [];
    const sourceOf = new Map(fixture.targets.map(target => [target.target.root_id, target.source_id]));
    expect(delivered.length + lines.length).toBe(Math.min(MEMBER_INDEX_ROOTS, sources.length));
    expect(lines.map(line => line.label)).toEqual(lines.map((_, i) => `R${String(delivered.length + i + 1).padStart(2, "0")}`));
    expect(new Set([...delivered, ...lines.map(line => line.root_id)]).size).toBe(delivered.length + lines.length);
    // Pool members first, then roots refused only by the nomination limit.
    const pool = lines.filter(line => line.in_pool).length;
    expect(delivered.length + pool).toBe(16);
    expect(lines.slice(0, pool).every(line => line.in_pool)).toBe(true);
    for (const line of lines) {
      const id = sourceOf.get(line.root_id)!, message = sources.find(source => source.id === id)!.message;
      expect(line.line).toBe(clipUtf8(message, 218));
      expect(line.producer).toBe(withStatement(id) ? "source-statements-v1" : "first-message");
      expect(line.statement_ids).toHaveLength(withStatement(id) ? 1 : 0);
      expect(line.date).toBe(sources.find(source => source.id === id)!.eventTime.slice(0, 10));
    }
    expect(lines.some(line => line.line.endsWith("…"))).toBe(true);
    const next = await call({ continuation: first.index!.continuation });
    expect(next.member_index).toBeUndefined();
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } }, async directory => {
    const environment = storageFixture(join(directory, "alaya.db"));
    try {
      for (const source of sources) {
        const published = publishMessages(environment, [{ role: "user", text: source.message }], source.id, WS,
          source.eventTime, "project");
        if (withStatement(source.id)) publishStatement(environment, published, `statement-${source.id}`);
      }
    } finally { environment.database.close({ optimize: false }); }
  });
}, 60_000);
