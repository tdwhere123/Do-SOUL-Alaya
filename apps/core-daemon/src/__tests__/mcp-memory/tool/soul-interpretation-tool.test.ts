import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { CoreError, fieldContractSha256 } from "@do-soul/alaya-core";
import {
  buildSourceReferenceCatalog,
  type SoulInterpretationResponse,
  type SourceSemanticWorkerRequest,
  type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import {
  callAlayaMcpMemoryTool,
  createAlayaMcpServer
} from "../../../mcp/server/mcp-server.js";
import { listAlayaMemoryTools } from "../../../mcp-memory/tool/tool-catalog.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import type {
  SourceSemanticHostPort,
  SourceSemanticPublicationPort
} from "../../../mcp-memory/tool/interpretation-handler.js";
import { context, createDeps } from "./mcp-memory-tool-handler-fixture.js";

const BUDGET = {
  schema_version: 1 as const,
  work_units: 200000,
  memory_bytes: 20000000,
  page_budget: 100000,
  finalization_reserve: 10000,
  min_envelope: 10
};

const SOURCE = "User: Alice uses tools.";
const CATALOG = buildSourceReferenceCatalog(fieldContractSha256(SOURCE), [
  { assertion_id: 1, text: SOURCE }
], fieldContractSha256);

const IDLE = {
  discovery: "unexercised",
  source_interpretation: "unexercised",
  query_semantics: "unexercised",
  semantic_correspondence: "unexercised",
  conditional_computation: "unexercised",
  payload: "complete"
} as const;

const WORK = {
  native_work: 4,
  native_bytes: 8,
  logical_memory_bytes: 16,
  rss_bytes: 32
} as const;

const DRAFT = {
  contract: "source-interpretation-v4" as const,
  mentions: [{ id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }],
  referents: [{ id: "rBob", referent_kind: "grouped" as const, mentions: ["mSent"] }],
  frames: [{
    id: "fSend",
    assertion_ids: [1],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
    additional_support: [],
    predicate_support: { kind: "explicit" as const, reading: "send", mentions: ["mSent"] },
    slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["mSent"] }] }],
    bindings: [{ slot_id: "agent", target: { kind: "node" as const, id: "rBob" }, support: [] }]
  }],
  operators: [],
  gaps: []
};

function workerResult(request: SourceSemanticWorkerRequest): SourceSemanticWorkerResult {
  if (request.kind === "validate_source") return { kind: "validate_source", source_id: "artifact-1", source_version: "1",
    content_digest: `sha256:${fieldContractSha256(SOURCE)}`, source: SOURCE, catalog: CATALOG,
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [0, Buffer.byteLength(SOURCE)] }], coverage: IDLE, work: WORK };
  if (request.kind === "prepare_source") {
    return {
      kind: "prepare_source",
      source_handle: "src-handle-1",
      source_id: request.source_id,
      source_version: "1",
      content_digest: `sha256:${fieldContractSha256(SOURCE)}`,
      catalog: CATALOG,
      coverage: { ...IDLE, discovery: "complete" },
      work: WORK
    };
  }
  if (request.kind === "prepare_query") {
    return {
      kind: "prepare_query",
      query_semantics_status: { status: "unavailable", reason: "absent" },
      outcome: { status: "preparation_required", missing: "query_semantics" },
      candidates: [],
      truncated: false,
      coverage: { ...IDLE, query_semantics: "open" },
      work: WORK
    };
  }
  return {
    kind: "reason",
    result: {
      contract: "source-interpretation-reasoning-v5",
      semantic_status: "unreviewed",
      world_claim: "unknown",
      consumed_leaves: [],
      conclusion_scope: "conditional_on_interpretation",
      outcome: { status: "interpreted", gaps: [] }
    },
    coverage: { ...IDLE, conditional_computation: "complete" },
    work: WORK
  };
}

function createPort(execute: SourceSemanticHostPort["execute"] = async ({ request }) => workerResult(request)): SourceSemanticHostPort {
  return { execute };
}

function createHandler(input: {
  readonly sourceSemanticsPort?: SourceSemanticHostPort;
  readonly publication?: SourceSemanticPublicationPort;
} = {}) {
  return createMcpMemoryToolHandler({
    ...createDeps(),
    ...(input.sourceSemanticsPort === undefined ? {} : { sourceSemanticsPort: input.sourceSemanticsPort }),
    ...(input.publication === undefined ? {} : { sourceSemanticPublication: input.publication })
  });
}

async function callInterpretation(
  handler: ReturnType<typeof createMcpMemoryToolHandler>,
  args: unknown
) {
  return await handler.call({
    toolName: "soul.interpretation",
    arguments: args,
    context
  });
}

describe("soul.interpretation MCP/CLI surface", () => {
  it("lists soul.interpretation beside ordinary Recall and hides it from a legacy catalog", async () => {
    const names = listAlayaMemoryTools().map((tool) => tool.name);
    expect(names).toContain("soul.interpretation");
    expect(names).toContain("soul.recall");
    const server = createAlayaMcpServer({
      memoryToolHandler: createHandler(),
      contextProvider: () => context
    });
    const client = new Client({ name: "interpretation-list", version: "test" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("soul.interpretation");
      expect(listed.tools.map((tool) => tool.name)).toContain("soul.recall");
    } finally {
      await client.close();
      await server.close();
    }

    const legacy = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createHandler(),
        contextProvider: () => context
      },
      "soul.interpretation.legacy",
      { operation: "prepare_source", source_id: "artifact-1", budget: BUDGET }
    );
    expect(legacy.isError).toBe(true);
    expect(legacy.structuredContent).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL" }
    });
  });

  it("rejects an unwired worker and keeps provider_attempts at 0", async () => {
    const missing = await callInterpretation(createHandler(), {
      operation: "prepare_source",
      source_id: "artifact-1",
      budget: BUDGET
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });

    const handler = createHandler({ sourceSemanticsPort: createPort() });
    const [mcp, direct] = await Promise.all([
      callAlayaMcpMemoryTool(
        { memoryToolHandler: handler, contextProvider: () => context },
        "soul.interpretation",
        { operation: "reason", accepts_unreviewed_conditional_results: true, budget: BUDGET, output_byte_limit: 4096 }
      ),
      callInterpretation(handler, {
        operation: "reason",
        accepts_unreviewed_conditional_results: true,
        budget: BUDGET,
        output_byte_limit: 4096
      })
    ]);
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error("reason missing semantic correspondence must succeed as a tool result");
    expect(direct.output).toMatchObject({
      operation: "reason",
      outcome: { status: "preparation_required", missing: "query_semantics_and_correspondence" },
      provider_attempts: 0
    });
    expect((mcp.structuredContent as { output: SoulInterpretationResponse }).output).toEqual(direct.output);
  });

  it("routes prepare_source through the worker with provider_attempts 0", async () => {
    const execute = vi.fn(async ({ request }: Parameters<SourceSemanticHostPort["execute"]>[0]) =>
      workerResult(request)
    );
    const handler = createHandler({ sourceSemanticsPort: { execute } });
    const result = await callInterpretation(handler, {
      operation: "prepare_source",
      source_id: "artifact-1",
      budget: BUDGET
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("prepare_source must succeed");
    expect(result.output).toMatchObject({
      operation: "prepare_source",
      source_handle: "src-handle-1",
      source_id: "artifact-1",
      provider_attempts: 0,
      work: WORK
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("awaits Core publish before returning propose", async () => {
    let finished = false;
    let assertionLocations: unknown;
    const publication: SourceSemanticPublicationPort = {
      publish: async (input) => {
        assertionLocations = input.assertion_locations;
        await Promise.resolve();
        finished = true;
        throw new CoreError("VALIDATION", "malformed interpretation");
      }
    };
    const handler = createHandler({
      sourceSemanticsPort: createPort(),
      publication
    });
    const prepared = await callInterpretation(handler, {
      operation: "prepare_source",
      source_id: "artifact-1",
      budget: BUDGET
    });
    expect(prepared.ok).toBe(true);
    const proposed = await callInterpretation(handler, {
      operation: "propose",
      source_handle: "src-handle-1",
      draft: DRAFT,
      producer_id: "author",
      producer_version: "1",
      contract_version: "source-interpretation-v4"
    });
    expect(finished).toBe(true);
    expect(assertionLocations).toEqual([{ assertion_id: 1, source_utf8_span: [0, Buffer.byteLength(SOURCE)] }]);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) throw new Error("propose must return a tool result");
    expect(proposed.output).toMatchObject({
      operation: "propose",
      outcome: { status: "invalid", reason: "malformed_interpretation" },
      provider_attempts: 0
    });
  });

  it("does not publish when the worker lease has expired", async () => {
    const publish = vi.fn(async () => {
      throw new Error("publish must not run");
    });
    const handler = createHandler({
      sourceSemanticsPort: createPort(async ({ request }) => {
        if (request.kind === "validate_source") {
          throw new CoreError("VALIDATION", "source semantic preparation handle expired", { details: { admission: "expired" } });
        }
        return workerResult(request);
      }),
      publication: { publish }
    });
    const prepared = await callInterpretation(handler, {
      operation: "prepare_source", source_id: "artifact-1", budget: BUDGET
    });
    expect(prepared.ok).toBe(true);
    const proposed = await callInterpretation(handler, {
      operation: "propose",
      source_handle: "src-handle-1",
      draft: DRAFT,
      producer_id: "author",
      producer_version: "1",
      contract_version: "source-interpretation-v4"
    });
    expect(publish).not.toHaveBeenCalled();
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) throw new Error("expired propose must return a tool result");
    expect(proposed.output).toMatchObject({
      operation: "propose",
      outcome: { status: "invalid", reason: "expired_handle" },
      provider_attempts: 0
    });
  });

  it("keeps ordinary Recall on the same handler with no provider calls", async () => {
    const handler = createHandler({ sourceSemanticsPort: createPort() });
    const recall = await handler.call({
      toolName: "soul.recall",
      arguments: {
        protocol_version: 1,
        supported_result_kinds: ["memory_entry", "source_evidence"],
        supports_source_evidence: true,
        supports_product_updates: true,
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      },
      context
    });
    expect(recall.ok).toBe(true);
    if (!recall.ok) throw new Error("ordinary recall must remain");
    expect(recall.tool_name).toBe("soul.recall");
    expect("delivery_id" in recall.output || "index" in recall.output || "results" in recall.output).toBe(true);
  });
});

it("forwards named scope admission to the worker instead of hard-wiring unrestricted", async () => {
  const execute = vi.fn<SourceSemanticHostPort["execute"]>(async ({ request, authorized_scopes }) => {
    expect(authorized_scopes).toEqual({ mode: "named", scopes: ["project"] });
    return workerResult(request);
  });
  const result = await callInterpretation(createHandler({ sourceSemanticsPort: { execute } }), {
    operation: "prepare_source", source_id: "artifact-1", budget: BUDGET,
    authorized_scopes: { mode: "named", scopes: ["project"] }
  });
  expect(result.ok).toBe(true);
  expect(execute).toHaveBeenCalled();
});

it("does not reinterpret an unavailable body as no eligible source", async () => {
  const unavailable = await callInterpretation(createHandler({ sourceSemanticsPort: createPort(async () => {
    throw new CoreError("CONFLICT", "current source body is not available", {
      details: { admission: "unavailable", unavailable: "source_body", work: WORK }
    });
  }) }), { operation: "prepare_source", source_id: "artifact-1", budget: BUDGET });
  expect(unavailable).toMatchObject({ ok: true, output: { outcome: { status: "unavailable", reason: "source_body" },
    coverage: { discovery: "open" }, work: WORK } });
  const absent = await callInterpretation(createHandler({ sourceSemanticsPort: createPort(async () => {
    throw new CoreError("NOT_FOUND", "source is not currently admitted", { details: { admission: "no_eligible_source", work: WORK } });
  }) }), { operation: "prepare_source", source_id: "artifact-1", budget: BUDGET });
  expect(absent).toMatchObject({ ok: true, output: { outcome: { status: "no_eligible_source", provider_attempts: 0 }, work: WORK } });
});

it("does not fold an unavailable body during propose into malformed interpretation", async () => {
  const publish = vi.fn<SourceSemanticPublicationPort["publish"]>(async () => {
    throw new CoreError("VALIDATION", "current source body is not available", {
      details: { admission: "unavailable", unavailable: "source_body", work: WORK }
    });
  });
  const result = await callInterpretation(createHandler({ sourceSemanticsPort: createPort(), publication: { publish } }), {
    operation: "propose", source_handle: "source-handle", draft: DRAFT,
    producer_id: "test", producer_version: "1", contract_version: "source-interpretation-v4", budget: BUDGET
  });
  expect(result).toMatchObject({ ok: true, output: { outcome: { status: "unavailable", reason: "source_body" }, provider_attempts: 0 } });
});

it("accepts a located no-proposition disposition without publishing a fictitious source interpretation", async () => {
  const publish = vi.fn<SourceSemanticPublicationPort["publish"]>(async () => { throw new Error("no source interpretation should be published"); });
  const handler = createHandler({ sourceSemanticsPort: createPort(), publication: { publish } });
  const row = CATALOG.assertions[0]!;
  const result = await callInterpretation(handler, { operation: "propose", source_handle: "source-handle",
    disposition: { status: "no_executable_proposition", description: "Producer disposition under an unreviewed interpretation",
      context_support: [{ kind: "source_reference", assertion_id: row.assertion_id,
        source_ref: { first: row.segments[0]!.id, last: row.segments.at(-1)!.id } }] },
    producer_id: "test", producer_version: "1", contract_version: "source-interpretation-v4", budget: BUDGET });
  expect(result).toMatchObject({ ok: true, output: { outcome: { status: "no_executable_proposition" },
    semantic_status: "unreviewed", source_binding: { source_id: "artifact-1" }, provider_attempts: 0 } });
  expect(publish).not.toHaveBeenCalled();
});

it("preserves publication budget exhaustion and adds post-preparation failure cost", async () => {
  const publish: SourceSemanticPublicationPort["publish"] = async () => { throw new CoreError("CONFLICT", "publication budget exhausted", {
    subCode: "RETRYABLE_BACKPRESSURE", details: { work: { native_work: 4, native_bytes: 80, logical_work: 12, logical_memory_bytes: 400, rss_bytes: 1 } }
  }); };
  const handler = createHandler({ sourceSemanticsPort: createPort(), publication: { publish } });
  const result = await callInterpretation(handler, { operation: "propose", source_handle: "source-handle", draft: DRAFT,
    producer_id: "test-author", producer_version: "1", contract_version: "source-interpretation-v4", budget: BUDGET });
  expect(result).toMatchObject({ ok: true, output: { outcome: { status: "resource_exhausted" },
    work: { native_work: WORK.native_work + 4, logical_work: WORK.native_work + 12,
      logical_memory_bytes: WORK.logical_memory_bytes + 400 }, provider_attempts: 0 } });
});
