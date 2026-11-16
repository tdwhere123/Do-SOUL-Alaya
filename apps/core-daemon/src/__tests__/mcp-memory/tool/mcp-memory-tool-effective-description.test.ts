import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { soulToolDefs } from "@do-soul/alaya-engine-gateway";
import { describe, expect, it } from "vitest";
import type { AlayaCliContext } from "../../../cli/bridge.js";
import { createToolsCommand } from "../../../cli/tools.js";
import { HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES } from "../../../mcp-memory/proposal/reviewer-surfaces.js";
import {
  ALAYA_MEMORY_TOOL_NAMES,
  type AlayaMemoryToolName
} from "../../../mcp-memory/tool/tool-catalog.js";
import type { McpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createAlayaMcpServer } from "../../../mcp/server/mcp-server.js";

/**
 * Daemon-owned loop suffixes, independent of `loopSuffixByName`.
 * Gateway `soulToolDefs` (SemVer-pinned) remain the base-text authority.
 */
const EXPECTED_LOOP_SUFFIX_BY_NAME = Object.freeze({
  "soul.recall":
    "Optional `enumeration_policy` (`native_query` default and the only value live execution accepts; `canonical` and `associative` stay parseable for historical readers but are rejected), `result_kind_view` (`mixed` default, or `memory_only`/`source_only`), `interpretation_proposal`, and `payload_continuation` are request identity/view fields. A source result with `target.span.content_complete=false` was cut at a page boundary: continue it before answering by repeating the request with the returned `index.continuation` and `payload_continuation` {schema_version:1, purpose:\"payload_expansion\", target: its index entry target, start_offset: span.content_end} until `content_complete` is true. For question-time preference, send a proposal with schema_version=1, producer_id=alaya.query.question-time.v1, producer_version=1, original_query_digest=sha256 of the exact UTF-8 query, and question_time={interpretation_clock: the same source_observed_at clock, intervals:[{start:YYYY-MM-DD,end:YYYY-MM-DD}]}. Form at most 32 closed UTC calendar-day alternatives from the question and clock only, never from sources or answers. This producer accepts only question_time, not programs or conditions. The window is a soft preference on source event_time under the existing root/attempt limits; since/until remain hard filters. Omit it when no window is formed. `associative` also requires declared `cap_contracts`; absence is incompatible (parse error), not a default. Results carry a tagged `target`; source-record-only rows use `object_kind` `source_evidence` and do not mint a memory id. Responses may include `page_purpose` and `product_updates`; retrying the same continuation replays the same `delivery_id`. Older consumers that cannot parse source targets must request `result_kind_view=memory_only` rather than dropping or recasting source rows. Start memory-sensitive turns here; use the returned delivery_id later in soul.report_context_usage. Mixed or source_only views require protocol_version=1 and source_evidence support; undeclared mixed is a compatibility error rather than a later parse failure.",
  "soul.open_pointer":
    "Use this before citing memory content so evidence is grounded in retrieved objects.",
  "soul.emit_candidate_signal":
    "This records candidate intent only; it does not create or mutate durable memory entries.",
  "soul.propose_memory_update":
    "This creates a pending proposal for governance; durable memory remains unchanged until acceptance apply.",
  "soul.review_memory_proposal":
    "Use only after listing pending proposals and obtaining explicit reviewer approval; accept triggers apply, reject preserves memory as-is.",
  "soul.list_pending_proposals":
    "Review queues represent governance state only; pending items are not durable memory writes.",
  "soul.propose_edge":
    "Pending edge proposals are governance queue items only; durable graph edges are written only after review.",
  "soul.list_pending_edge_proposals":
    "Read-only inspection aid for graph governance; pending items are not durable path relations.",
  "soul.batch_review_edge_proposals":
    "Use only after explicit reviewer approval; accept mints a durable path relation, reject preserves graph state.",
  "soul.apply_override":
    "Session-only correction for the current run; it does not promote durable memory by itself.",
  "soul.explore_graph":
    "Inspection aid for related memories; keep write actions on proposal/candidate tools.",
  "soul.report_context_usage":
    "Close the delivery loop by marking used/skipped/not_applicable so trust state stays explicit.",
  "soul.capture_host_session":
    "Captured messages are source input, not claims of truth; a repeated window admits nothing new.",
  "soul.resolve":
    "Apply a resolution against a staged warning surfaced by soul.recall; the audit event is the durable record of the decision.",
  "soul.interpretation": "",
  "garden.list_pending_tasks": "",
  "garden.claim_task": "",
  "garden.complete_task": ""
}) satisfies Readonly<Record<AlayaMemoryToolName, string>>;

const unusedHandler: McpMemoryToolHandler = {
  call: async () => {
    throw new Error("effective-description list_tools test must not call tools");
  }
};

describe("MCP client-visible memory tool descriptions", () => {
  it("publishes gateway base text plus the daemon loop suffix over list_tools", async () => {
    expect(Object.keys(EXPECTED_LOOP_SUFFIX_BY_NAME)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    expect(soulToolDefs.map((spec) => spec.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);

    const expectedByName = expectedEffectiveDescriptionByName();
    const listed = await listToolsForAgentTarget("inspector");

    expect(listed.map((tool) => tool.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    for (const published of listed) {
      const name = published.name as AlayaMemoryToolName;
      const expected = expectedByName.get(name);
      expect(expected, `missing independent expected description for ${name}`).toBeDefined();
      expect(published.description).toBe(expected);
    }

    expect(listed.find((tool) => tool.name === "soul.recall")?.description).toContain("information index");
    expect(listed.find((tool) => tool.name === "soul.recall")?.description).toContain("payload_continuation");
    expect(EXPECTED_LOOP_SUFFIX_BY_NAME["soul.recall"]).not.toContain("information index");
    expect(soulToolDefs.find((spec) => spec.name === "soul.recall")?.description).not.toContain(
      "payload_continuation"
    );

    for (const name of ["soul.interpretation", "garden.list_pending_tasks", "garden.claim_task", "garden.complete_task"] as const) {
      expect(EXPECTED_LOOP_SUFFIX_BY_NAME[name]).toBe("");
      expect(listed.find((tool) => tool.name === name)?.description).toBe(
        soulToolDefs.find((spec) => spec.name === name)?.description
      );
    }
  });

  it("keeps attached-agent list_tools descriptions identical for the visible subset", async () => {
    const expectedByName = expectedEffectiveDescriptionByName();
    const listed = await listToolsForAgentTarget("codex");
    const hidden = new Set<string>(HUMAN_REVIEW_ONLY_MEMORY_TOOL_NAMES);

    expect(listed.map((tool) => tool.name)).toEqual(
      ALAYA_MEMORY_TOOL_NAMES.filter((name) => !hidden.has(name))
    );
    expect(listed.map((tool) => tool.name)).not.toContain("soul.review_memory_proposal");
    expect(listed.map((tool) => tool.name)).not.toContain("soul.batch_review_edge_proposals");
    for (const published of listed) {
      expect(published.description).toBe(expectedByName.get(published.name as AlayaMemoryToolName));
    }
  });

  it("lists an empty catalog as no tools and still rejects unknown calls", async () => {
    const listed = await listToolsForAgentTarget("inspector", []);
    expect(listed).toEqual([]);

    const server = createAlayaMcpServer({
      memoryToolHandler: unusedHandler,
      contextProvider: () => ({
        workspaceId: "ws-effective-description",
        runId: null,
        agentTarget: "codex",
        sessionId: "effective-description-unknown"
      }),
      tools: []
    });
    const client = new Client({ name: "effective-description-unknown", version: "test" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools).toEqual([]);
      const unknown = await client.callTool({ name: "soul.review_memory_proposal", arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({
        ok: false,
        error: { code: "UNKNOWN_TOOL" }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists the same effective descriptions on the CLI catalog", async () => {
    const expectedByName = expectedEffectiveDescriptionByName();
    const command = createToolsCommand({ handler: unusedHandler });
    const result = await command.handler(createCliContext(), {
      action: "list",
      toolName: null,
      input: {},
      contextOverrides: { workspaceId: null, runId: undefined, agentTarget: null }
    });

    expect(result.exitCode).toBe(0);
    const tools = (result.json as { readonly tools: readonly { readonly name: string; readonly description: string }[] })
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description).toBe(expectedByName.get(tool.name as AlayaMemoryToolName));
    }
  });
});

function expectedEffectiveDescriptionByName(): ReadonlyMap<AlayaMemoryToolName, string> {
  const byName = new Map<AlayaMemoryToolName, string>();
  for (const spec of soulToolDefs) {
    const name = spec.name as AlayaMemoryToolName;
    const suffix = EXPECTED_LOOP_SUFFIX_BY_NAME[name].trim();
    byName.set(name, suffix.length === 0 ? spec.description : `${spec.description} ${suffix}`);
  }
  return byName;
}

async function listToolsForAgentTarget(
  agentTarget: string,
  tools: readonly [] | undefined = undefined
): Promise<readonly { readonly name: string; readonly description: string | undefined }[]> {
  const server = createAlayaMcpServer({
    memoryToolHandler: unusedHandler,
    contextProvider: () => ({
      workspaceId: "ws-effective-description",
      runId: null,
      agentTarget,
      sessionId: `effective-description-${agentTarget}`
    }),
    ...(tools === undefined ? {} : { tools })
  });
  const client = new Client({ name: "effective-description", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    return listed.tools.map((tool) => ({ name: tool.name, description: tool.description }));
  } finally {
    await client.close();
    await server.close();
  }
}

function createCliContext(): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] }
  };
}
