import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence, MemoryObject } from "../contracts/index.js";
import { createSoulMemoryMcpHandler, type JsonRpcResponse } from "../mcp/index.js";
import { createSoulMemoryRuntime, type SoulMemoryRuntime } from "../runtime/index.js";
import { dispatchSoulMemoryHttpRoute } from "../server/index.js";

const tmpRoots: string[] = [];
const now = "2026-04-27T00:00:00.000Z";

type JsonRecord = Record<string, unknown>;

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SOUL Memory adapters", () => {
  it("serves inspector assets and memory API routes over localhost HTTP", async () => {
    const runtime = await makeRuntime();
    try {
      const health = asRecord((await route(runtime, "GET", "/api/memory/health")).body);
      expect(health.ok).toBe(true);

      const html = String((await route(runtime, "GET", "/")).body);
      expect(html).toContain("SOUL Memory Inspector");

      const invalidRecall = await dispatchSoulMemoryHttpRoute(runtime, {
        method: "POST",
        path: "/api/memory/recall",
        body: {}
      });
      expect(invalidRecall.status).toBe(400);
      expect(asRecord(asRecord(invalidRecall.body).error).code).toBe("VALIDATION_FAILED");

      const invalidIngest = await dispatchSoulMemoryHttpRoute(runtime, {
        method: "POST",
        path: "/api/memory/memories",
        body: { memory: null }
      });
      expect(invalidIngest.status).toBe(400);
      expect(asRecord(asRecord(invalidIngest.body).error).code).toBe("VALIDATION_FAILED");

      const missingRoute = await dispatchSoulMemoryHttpRoute(runtime, {
        method: "GET",
        path: "/api/memory/unknown"
      });
      expect(missingRoute.status).toBe(404);

      const memory = sampleMemory("mem-http-adapter");
      const evidence = sampleEvidence(memory.id);
      const ingest = asRecord((await route(runtime, "POST", "/api/memory/memories", { memory, evidence: [evidence] })).body);
      expect(asRecord(ingest.memory).id).toBe(memory.id);

      const recall = asRecord((await route(runtime, "POST", "/api/memory/recall", { query: "adapter route smoke" })).body);
      expect(asArray(recall.candidates).map((candidate) => asRecord(candidate).memoryId)).toContain(memory.id);

      const context = asRecord((await route(runtime, "POST", "/api/memory/context", { query: "adapter route smoke" })).body);
      const contextPack = asRecord(context.contextPack);
      expect(contextPack.id).toMatch(/^context:/);

      const fetchedPack = asRecord((await route(
        runtime,
        "GET",
        `/api/memory/context-packs/${encodeURIComponent(String(contextPack.id))}`
      )).body);
      expect(fetchedPack.id).toBe(contextPack.id);

      const graph = asRecord((await route(runtime, "GET", "/api/memory/graph")).body);
      expect(asArray(asRecord(graph.graph).nodes).map((node) => asRecord(node).id)).toContain(memory.id);

      const auditEvents = (await route(runtime, "GET", "/api/memory/audit-events")).body;
      expect(Array.isArray(auditEvents)).toBe(true);
    } finally {
      runtime.close();
    }
  });

  it("rejects HTTP backup paths that escape storage through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "soul-memory-adapters-backup-"));
    tmpRoots.push(root);
    const runtime = createSoulMemoryRuntime({
      path: join(root, "data", "soul-memory.db"),
      now: () => now
    });
    try {
      await mkdir(join(root, "outside"), { recursive: true });
      await symlink(join(root, "outside"), join(root, "data", "link-out"), "dir");
      const response = await dispatchSoulMemoryHttpRoute(runtime, {
        method: "POST",
        path: "/api/memory/backup",
        body: { path: join(root, "data", "link-out", "backup.db") }
      });
      expect(response.status).toBe(400);
      expect(asRecord(asRecord(response.body).error).code).toBe("VALIDATION_FAILED");

      const danglingLink = join(root, "data", "dangling-backup.db");
      await symlink(join(root, "outside", "dangling-backup.db"), danglingLink);
      const danglingResponse = await dispatchSoulMemoryHttpRoute(runtime, {
        method: "POST",
        path: "/api/memory/backup",
        body: { path: danglingLink }
      });
      expect(danglingResponse.status).toBe(400);
      expect(asRecord(asRecord(danglingResponse.body).error).code).toBe("VALIDATION_FAILED");
    } finally {
      runtime.close();
    }
  });

  it("handles MCP initialize, tool listing, and tool calls through the runtime", async () => {
    const runtime = await makeRuntime();
    try {
      const handler = createSoulMemoryMcpHandler(runtime);
      const init = await handler({ jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(asRecord(asRecord(init).result).serverInfo).toMatchObject({ name: "soul-memory-product-local" });

      const toolList = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listedTools = asArray(asRecord(asRecord(toolList).result).tools).map((tool) => asRecord(tool).name);
      expect(listedTools).toContain("soul_memory.recall");
      expect(listedTools).toContain("soul_memory.ingest_memory");
      expect(listedTools).toContain("soul_memory.explain_recall");
      expect(listedTools).toContain("soul_memory.list_session_violations");

      const memory = sampleMemory("mem-mcp-adapter");
      const ingest = await handler({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "soul_memory.ingest_memory",
          arguments: { memory, evidence: [sampleEvidence(memory.id)] }
        }
      });
      expect(asRecord(toolPayload(ingest).memory).id).toBe(memory.id);

      const recall = await handler({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "soul_memory.recall",
          arguments: { query: "mcp adapter smoke" }
        }
      });
      const payload = toolPayload(recall);
      expect(asArray(payload.candidates).map((candidate) => asRecord(candidate).memoryId)).toContain(memory.id);

      const explain = await handler({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "soul_memory.explain_recall",
          arguments: { candidateId: `recall:${memory.id}` }
        }
      });
      expect(asRecord(asRecord(toolPayload(explain).candidate).sourceRef).ref).toBe("adapters.test.ts");

      const session = await handler({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "soul_memory.start_session",
          arguments: { agent: { kind: "codex", client: "test" }, mode: "gateway" }
        }
      });
      const sessionPayload = toolPayload(session);
      expect(asRecord(asRecord(sessionPayload.session).agent).kind).toBe("codex");
      const sessionId = String(asRecord(sessionPayload.session).id);
      const violations = await handler({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "soul_memory.list_session_violations",
          arguments: { sessionId }
        }
      });
      expect(asArray(toolPayload(violations).violations)).toEqual([]);
    } finally {
      runtime.close();
    }
  });
});

async function route(
  runtime: SoulMemoryRuntime,
  method: string,
  path: string,
  body?: unknown
): ReturnType<typeof dispatchSoulMemoryHttpRoute> {
  const response = await dispatchSoulMemoryHttpRoute(runtime, { method, path, body });
  expect(response.status).toBe(200);
  return response;
}

async function makeRuntime(): Promise<SoulMemoryRuntime> {
  const root = await mkdtemp(join(tmpdir(), "soul-memory-adapters-"));
  tmpRoots.push(root);
  return createSoulMemoryRuntime({
    path: join(root, "soul-memory.db"),
    now: () => now
  });
}

function toolPayload(response: JsonRpcResponse | undefined): JsonRecord {
  const result = asRecord(asRecord(response).result);
  const content = asArray(result.content);
  const first = asRecord(content[0]);
  expect(first.type).toBe("text");
  return JSON.parse(String(first.text)) as JsonRecord;
}

function sampleMemory(id: string): MemoryObject {
  return {
    id,
    plane: "project-local",
    scopeId: "scope-adapter-smoke",
    kind: "constraint",
    durability: "durable",
    lifecycle: "accepted",
    content: {
      summary: "Adapter smoke tests should recall this local prototype memory.",
      body: "HTTP and MCP adapter smoke coverage should route through the SOUL Memory runtime."
    },
    facets: [{ key: "topic", value: "adapter route smoke", confidence: 1 }],
    source: {
      id: `source-${id}`,
      type: "operator",
      ref: "adapters.test.ts",
      actor: "test",
      observedAt: now
    },
    evidenceIds: [`evidence-${id}`],
    confidence: 0.95,
    strength: 0.9,
    createdAt: now,
    tags: ["adapter", "smoke"]
  };
}

function sampleEvidence(memoryId: string): Evidence {
  return {
    id: `evidence-${memoryId}`,
    type: "operator-statement",
    source: {
      id: `source-${memoryId}`,
      type: "operator",
      ref: "adapters.test.ts",
      actor: "test",
      observedAt: now
    },
    summary: "Adapter smoke tests require runtime-backed route behavior.",
    payload: { memoryId },
    createdAt: now,
    confidence: 1
  };
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
