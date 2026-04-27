#!/usr/bin/env node
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type AssembleContextInput,
  type ExportBundleInput,
  type GovernMemoryInput,
  type ListAuditEventsInput,
  type ListMemoriesInput,
  type RecordMemoryIngestInput,
  type RecordMemoryUsageInput,
  type SoulMemoryPublicApi,
  type StartMemorySessionInput
} from "../contracts/index.js";
import { createDefaultRuntime, RuntimeError } from "../runtime/index.js";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc?: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type SoulMemoryMcpHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>;

type JsonRecord = Record<string, unknown>;

const tools = [
  tool("soul_memory.health", "Return runtime health and schema version."),
  tool("soul_memory.recall", "Recall relevant memories for a query.", {
    query: { type: "string" },
    limit: { type: "number" }
  }),
  tool("soul_memory.assemble_context", "Assemble a context pack for a query or session.", {
    query: { type: "string" },
    sessionId: { type: "string" },
    limit: { type: "number" }
  }),
  tool("soul_memory.start_session", "Start a memory session.", {
    agent: { type: "object" },
    mode: { type: "string" },
    project: { type: "string" },
    workspace: { type: "string" }
  }),
  tool("soul_memory.finish_session", "Finish a memory session.", {
    sessionId: { type: "string" },
    usageState: { type: "string" },
    ingestState: { type: "string" }
  }),
  tool("soul_memory.record_usage", "Record memory delivery or usage proof.", {
    sessionId: { type: "string" },
    kind: { type: "string" },
    state: { type: "string" }
  }),
  tool("soul_memory.record_ingest", "Record post-run memory ingest state.", {
    sessionId: { type: "string" },
    kind: { type: "string" },
    state: { type: "string" }
  }),
  tool("soul_memory.ingest_memory", "Ingest an evidence-backed memory.", {
    memory: { type: "object" },
    evidence: { type: "array" }
  }),
  tool("soul_memory.ingest_evidence", "Attach evidence to an existing memory.", {
    evidence: { type: "object" },
    memoryId: { type: "string" }
  }),
  tool("soul_memory.explain_recall", "Explain a recall candidate.", {
    candidateId: { type: "string" }
  }),
  tool("soul_memory.list_memories", "List memory objects."),
  tool("soul_memory.list_audit_events", "List audit events."),
  tool("soul_memory.list_session_violations", "List memory session contract violations.", {
    sessionId: { type: "string" }
  }),
  tool("soul_memory.governance", "Accept, reject, retire, or mark sensitive a memory.", {
    action: { type: "string" },
    memoryId: { type: "string" },
    reason: { type: "string" }
  }),
  tool("soul_memory.export_bundle", "Export a portable memory bundle.")
] as const;

export function createSoulMemoryMcpHandler(runtime: SoulMemoryPublicApi): SoulMemoryMcpHandler {
  return async (request) => handleSoulMemoryMcpRequest(runtime, request);
}

export async function handleSoulMemoryMcpRequest(
  runtime: SoulMemoryPublicApi,
  request: JsonRpcRequest
): Promise<JsonRpcResponse | undefined> {
  if (request.method === "notifications/initialized") {
    return undefined;
  }
  try {
    const result = await routeMcpRequest(runtime, request);
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: {
        code: error instanceof RuntimeError && error.code === "NOT_FOUND" ? -32004 : -32603,
        message: error instanceof Error ? error.message : String(error),
        data: error instanceof RuntimeError ? { code: error.code } : undefined
      }
    };
  }
}

export async function runSoulMemoryMcpStdio(
  runtime: SoulMemoryPublicApi & { close?: () => void } = createDefaultRuntime()
): Promise<void> {
  const handler = createSoulMemoryMcpHandler(runtime);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(JSON.stringify(jsonRpcError(null, -32700, "Parse error.")) + "\n");
      continue;
    }
    const response = await handler(request);
    if (response !== undefined) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
  runtime.close?.();
}

async function routeMcpRequest(runtime: SoulMemoryPublicApi, request: JsonRpcRequest): Promise<unknown> {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "soul-memory-product-local",
        version: (await runtime.getVersion()).version
      }
    };
  }
  if (request.method === "tools/list") {
    return { tools };
  }
  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const name = stringField(params, "name") ?? "";
    const args = asRecord(params.arguments);
    return toolResponse(await callTool(runtime, name, args));
  }
  throw new RuntimeError("VALIDATION_FAILED", `Unsupported JSON-RPC method '${request.method}'.`);
}

async function callTool(runtime: SoulMemoryPublicApi, name: string, args: JsonRecord): Promise<unknown> {
  const toolName = name.startsWith("soul_memory.") ? name : `soul_memory.${name}`;
  switch (toolName) {
    case "soul_memory.health":
      return runtime.health();
    case "soul_memory.recall":
      return runtime.recall(args as unknown as Parameters<SoulMemoryPublicApi["recall"]>[0]);
    case "soul_memory.assemble_context": {
      const input = args as unknown as AssembleContextInput;
      const sessionId = stringField(args, "sessionId");
      return sessionId === undefined ? runtime.assembleContext(input) : runtime.assembleContextForSession(sessionId, input);
    }
    case "soul_memory.start_session":
      return runtime.startMemorySession(args as unknown as StartMemorySessionInput);
    case "soul_memory.finish_session": {
      const sessionId = requireString(args, "sessionId");
      return runtime.finishMemorySession(sessionId, {
        finishedAt: stringField(args, "finishedAt") ?? new Date().toISOString(),
        usageState: stringField(args, "usageState") ?? "unverifiable",
        ingestState: stringField(args, "ingestState") ?? "not-requested"
      } as Parameters<SoulMemoryPublicApi["finishMemorySession"]>[1]);
    }
    case "soul_memory.record_usage":
      return runtime.recordMemoryUsage(normalizeUsageInput(args));
    case "soul_memory.record_ingest":
      return runtime.recordMemoryIngest(normalizeIngestInput(args));
    case "soul_memory.ingest_memory":
      return runtime.ingestMemory(args as unknown as Parameters<SoulMemoryPublicApi["ingestMemory"]>[0]);
    case "soul_memory.ingest_evidence":
      return runtime.ingestEvidence(args as unknown as Parameters<SoulMemoryPublicApi["ingestEvidence"]>[0]);
    case "soul_memory.explain_recall":
      return runtime.explainRecall({
        candidateId: requireString(args, "candidateId")
      });
    case "soul_memory.list_memories":
      return runtime.listMemories(args as unknown as ListMemoriesInput);
    case "soul_memory.list_audit_events":
      return runtime.listAuditEvents(args as unknown as ListAuditEventsInput);
    case "soul_memory.list_session_violations":
      return runtime.listSessionViolations(args as unknown as Parameters<SoulMemoryPublicApi["listSessionViolations"]>[0]);
    case "soul_memory.governance":
      return governance(runtime, args);
    case "soul_memory.export_bundle":
      return runtime.exportBundle(args as unknown as ExportBundleInput);
    default:
      throw new RuntimeError("VALIDATION_FAILED", `Unsupported tool '${name}'.`);
  }
}

async function governance(runtime: SoulMemoryPublicApi, args: JsonRecord): Promise<unknown> {
  const action = requireString(args, "action");
  const input: GovernMemoryInput = {
    memoryId: requireString(args, "memoryId"),
    actor: stringField(args, "actor") ?? "operator",
    reason: requireString(args, "reason")
  };
  if (action === "accept") {
    return runtime.acceptMemory(input);
  }
  if (action === "reject") {
    return runtime.rejectMemory(input);
  }
  if (action === "retire") {
    return runtime.retireMemory(input);
  }
  if (action === "mark-sensitive") {
    return runtime.markSensitive({ ...input, policy: { level: "sensitive", reason: input.reason } });
  }
  throw new RuntimeError("VALIDATION_FAILED", `Unsupported governance action '${action}'.`);
}

function normalizeUsageInput(args: JsonRecord): RecordMemoryUsageInput {
  const eventRecord = asRecord(args.event ?? args);
  return {
    event: {
      ...eventRecord,
      id: stringField(eventRecord, "id") ?? `usage:${Date.now()}`,
      sessionId: requireString(eventRecord, "sessionId"),
      kind: stringField(eventRecord, "kind") ?? "usage-proof-unavailable",
      at: stringField(eventRecord, "at") ?? new Date().toISOString(),
      state: stringField(eventRecord, "state") ?? "unverifiable"
    } as RecordMemoryUsageInput["event"]
  };
}

function normalizeIngestInput(args: JsonRecord): RecordMemoryIngestInput {
  const eventRecord = asRecord(args.event ?? args);
  return {
    event: {
      ...eventRecord,
      id: stringField(eventRecord, "id") ?? `ingest:${Date.now()}`,
      sessionId: requireString(eventRecord, "sessionId"),
      kind: stringField(eventRecord, "kind") ?? "ingest-skipped",
      at: stringField(eventRecord, "at") ?? new Date().toISOString(),
      state: stringField(eventRecord, "state") ?? "skipped"
    } as RecordMemoryIngestInput["event"]
  };
}

function toolResponse(value: unknown): unknown {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value)
      }
    ]
  };
}

function tool(name: string, description: string, properties: JsonRecord = {}): unknown {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      additionalProperties: true
    }
  };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function requireString(record: JsonRecord, key: string): string {
  const value = stringField(record, key);
  if (value === undefined || value.length === 0) {
    throw new RuntimeError("VALIDATION_FAILED", `${key} is required.`);
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("soul-memory MCP stdio server. Send JSON-RPC lines on stdin.\n");
    process.exit(0);
  }
  runSoulMemoryMcpStdio().catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
    process.exitCode = 1;
  });
}
