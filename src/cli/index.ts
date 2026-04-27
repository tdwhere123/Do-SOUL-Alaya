#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssembleContextInput,
  type Evidence,
  type ExportBundleInput,
  type FinishMemorySessionInput,
  type GovernMemoryInput,
  type ImportBundleInput,
  type IngestMemoryInput,
  type MemoryObject,
  type RecordMemoryIngestInput,
  type RecordMemoryUsageInput,
  type SoulMemoryPublicApi,
  type StartMemorySessionInput
} from "../contracts/index.js";
import {
  createRuntimeForDataPath,
  listenSoulMemoryHttpServer,
  resolveSoulMemoryDataPath
} from "../server/index.js";

interface ParsedCli {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean>;
  readonly commandAfterDash: readonly string[];
}

type JsonRecord = Record<string, unknown>;

const defaultAgent = { kind: "cli", client: "soul-memory", version: "0.0.0-local" };

export async function runSoulMemoryCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCli(argv);
  const dataDir = optionString(parsed.options, "data-dir");
  const dataPath = optionString(parsed.options, "data-path");
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    printHelp();
    return;
  }
  if (parsed.command === "serve") {
    await commandServe(parsed);
    return;
  }
  if (parsed.command === "inspector") {
    printJson(inspectorInfo(parsed, dataDir, dataPath));
    return;
  }
  if (parsed.command === "mcp") {
    printJson(commandMcp(parsed, dataDir, dataPath));
    return;
  }

  const runtime = createRuntimeForDataPath({ dataDir, dataPath });
  try {
    switch (parsed.command) {
      case "setup":
        await commandSetup(runtime, dataDir, dataPath);
        break;
      case "doctor":
        printJson(await runtime.doctor());
        break;
      case "ingest":
        printJson(await runtime.ingestMemory(await ingestInput(parsed)));
        break;
      case "recall":
        printJson(await runtime.recall(recallInput(parsed)));
        break;
      case "context":
        printJson(await commandContext(runtime, parsed));
        break;
      case "session":
        printJson(await commandSession(runtime, parsed));
        break;
      case "govern":
        printJson(await commandGovern(runtime, parsed));
        break;
      case "export":
        printJson(await commandExport(runtime, parsed));
        break;
      case "import":
        printJson(await commandImport(runtime, parsed));
        break;
      case "backup":
        printJson(await runtime.backup({ path: requiredOption(parsed.options, "path") }));
        break;
      case "gateway":
      case "run":
        await commandGateway(runtime, parsed);
        break;
      default:
        throw new Error(`Unknown command '${parsed.command}'.`);
    }
  } finally {
    if (parsed.command !== "serve") {
      runtime.close();
    }
  }
}

async function commandSetup(
  runtime: SoulMemoryPublicApi,
  dataDir: string | undefined,
  dataPath: string | undefined
): Promise<void> {
  const resolvedPath = resolveSoulMemoryDataPath({ dataDir, dataPath });
  if (resolvedPath !== ":memory:") {
    await mkdir(dirname(resolvedPath), { recursive: true });
  }
  printJson({
    dataPath: resolvedPath,
    health: await runtime.health(),
    doctor: await runtime.doctor()
  });
}

async function commandServe(parsed: ParsedCli): Promise<void> {
  const result = await listenSoulMemoryHttpServer({
    host: optionString(parsed.options, "host") ?? "127.0.0.1",
    port: optionNumber(parsed.options, "port") ?? 8787,
    dataDir: optionString(parsed.options, "data-dir"),
    dataPath: optionString(parsed.options, "data-path")
  });
  printJson({
    dataPath: result.dataPath,
    apiUrl: result.url,
    inspectorUrl: result.inspectorUrl,
    mcp: "stdio"
  });
  await new Promise<void>((resolve) => {
    const close = (): void => {
      result.server.close(() => resolve());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    result.server.once("close", resolve);
  });
}

async function commandContext(runtime: SoulMemoryPublicApi, parsed: ParsedCli): Promise<unknown> {
  const input = recallInput(parsed) as AssembleContextInput;
  const sessionId = optionString(parsed.options, "session-id");
  return sessionId === undefined ? runtime.assembleContext(input) : runtime.assembleContextForSession(sessionId, input);
}

async function commandSession(runtime: SoulMemoryPublicApi, parsed: ParsedCli): Promise<unknown> {
  const subcommand = parsed.positionals[0] ?? "start";
  const sessionId = parsed.positionals[1] ?? optionString(parsed.options, "session-id");
  if (subcommand === "start") {
    return runtime.startMemorySession(sessionInput(parsed));
  }
  if (sessionId === undefined) {
    throw new Error("session id is required.");
  }
  if (subcommand === "get") {
    return runtime.getMemorySession(sessionId);
  }
  if (subcommand === "finish") {
    return runtime.finishMemorySession(sessionId, finishInput(parsed));
  }
  if (subcommand === "context") {
    return runtime.assembleContextForSession(sessionId, recallInput(parsed) as AssembleContextInput);
  }
  if (subcommand === "usage") {
    return runtime.recordMemoryUsage(usageInput(sessionId, parsed));
  }
  if (subcommand === "ingest") {
    return runtime.recordMemoryIngest(ingestEventInput(sessionId, parsed));
  }
  if (subcommand === "violations") {
    return runtime.listSessionViolations({ sessionId });
  }
  throw new Error(`Unknown session subcommand '${subcommand}'.`);
}

async function commandGovern(runtime: SoulMemoryPublicApi, parsed: ParsedCli): Promise<unknown> {
  const action = parsed.positionals[0] ?? optionString(parsed.options, "action") ?? "";
  const memoryId = parsed.positionals[1] ?? requiredOption(parsed.options, "memory-id");
  const input: GovernMemoryInput = {
    memoryId,
    actor: optionString(parsed.options, "actor") ?? "operator",
    reason: requiredOption(parsed.options, "reason")
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
  throw new Error(`Unknown governance action '${action}'.`);
}

async function commandExport(runtime: SoulMemoryPublicApi, parsed: ParsedCli): Promise<unknown> {
  const output = await runtime.exportBundle(exportInput(parsed));
  const file = optionString(parsed.options, "file");
  if (file !== undefined) {
    await writeFile(file, JSON.stringify(output.bundle, null, 2), "utf8");
    return { path: file, exportedMemoryCount: output.bundle.memories.length };
  }
  return output;
}

async function commandImport(runtime: SoulMemoryPublicApi, parsed: ParsedCli): Promise<unknown> {
  const input = await jsonInput(parsed);
  const record = asRecord(input);
  const payload: ImportBundleInput = "bundle" in record
    ? record as unknown as ImportBundleInput
    : {
        bundle: input as ImportBundleInput["bundle"],
        mode: (optionString(parsed.options, "mode") ?? "merge") as ImportBundleInput["mode"]
      };
  return runtime.importBundle(payload);
}

async function commandGateway(runtime: SoulMemoryPublicApi, parsed: ParsedCli): Promise<void> {
  const query = optionString(parsed.options, "query") ?? (parsed.commandAfterDash.join(" ") || "gateway session");
  const session = await runtime.startMemorySession({
    agent: {
      kind: optionString(parsed.options, "agent") ?? "gateway",
      client: "soul-memory-cli",
      version: "0.0.0-local"
    },
    mode: "gateway",
    project: optionString(parsed.options, "project"),
    workspace: optionString(parsed.options, "workspace") ?? process.cwd()
  });
  const context = await runtime.assembleContextForSession(session.session.id, {
    query,
    limit: optionNumber(parsed.options, "limit")
  });
  const now = new Date().toISOString();
  for (const entry of context.contextPack.included) {
    await runtime.recordMemoryUsage({
      event: {
        id: `usage:${entry.memoryId}:${Date.now()}`,
        sessionId: session.session.id,
        kind: "recall-item-delivered",
        at: now,
        memoryId: entry.memoryId,
        contextPackId: context.contextPack.id,
        state: "delivered",
        proof: "Gateway attached context pack before command execution.",
        reason: entry.reason
      }
    });
  }

  const commandResult = parsed.commandAfterDash.length === 0
    ? undefined
    : await runCommand(parsed.commandAfterDash, {
        SOUL_MEMORY_SESSION_ID: session.session.id,
        SOUL_MEMORY_CONTEXT_PACK_ID: context.contextPack.id
      });

  if (commandResult !== undefined) {
    await runtime.recordMemoryUsage({
      event: {
        id: `usage:gateway:${Date.now()}`,
        sessionId: session.session.id,
        kind: "usage-proof-unavailable",
        at: new Date().toISOString(),
        contextPackId: context.contextPack.id,
        state: "unverifiable",
        proof: `Gateway command exited with ${commandResult.exitCode}.`,
        reason: "The gateway can prove delivery but not downstream semantic usage."
      }
    });
  }

  await runtime.recordMemoryIngest({
    event: {
      id: `ingest:gateway:${Date.now()}`,
      sessionId: session.session.id,
      kind: "no-durable-memory-created",
      at: new Date().toISOString(),
      state: "skipped",
      reason: "Gateway adapter did not ingest a post-run memory in this minimal slice."
    }
  });

  const finished = await runtime.finishMemorySession(session.session.id, {
    finishedAt: new Date().toISOString(),
    usageState: commandResult === undefined ? (context.contextPack.included.length > 0 ? "delivered" : "not-delivered") : "unverifiable",
    ingestState: "skipped"
  });
  printJson({
    session: finished.session,
    contextPack: context.contextPack,
    command: commandResult
  });
  if (commandResult !== undefined && commandResult.exitCode !== 0) {
    process.exitCode = commandResult.exitCode;
  }
}

function sessionInput(parsed: ParsedCli): StartMemorySessionInput {
  return {
    agent: {
      kind: optionString(parsed.options, "agent") ?? defaultAgent.kind,
      client: optionString(parsed.options, "client") ?? defaultAgent.client,
      version: optionString(parsed.options, "agent-version") ?? defaultAgent.version
    },
    mode: optionString(parsed.options, "mode") ?? "gateway",
    host: optionString(parsed.options, "host-name"),
    project: optionString(parsed.options, "project"),
    workspace: optionString(parsed.options, "workspace") ?? process.cwd()
  } as StartMemorySessionInput;
}

function recallInput(parsed: ParsedCli): Parameters<SoulMemoryPublicApi["recall"]>[0] {
  return {
    query: optionString(parsed.options, "query") ?? parsed.positionals.join(" "),
    limit: optionNumber(parsed.options, "limit"),
    planes: optionList(parsed.options, "plane") as Parameters<SoulMemoryPublicApi["recall"]>[0]["planes"],
    scopeIds: optionList(parsed.options, "scope-id")
  };
}

function finishInput(parsed: ParsedCli): FinishMemorySessionInput {
  return {
    finishedAt: optionString(parsed.options, "finished-at") ?? new Date().toISOString(),
    usageState: optionString(parsed.options, "usage-state") ?? "unverifiable",
    ingestState: optionString(parsed.options, "ingest-state") ?? "not-requested"
  } as FinishMemorySessionInput;
}

function usageInput(sessionId: string, parsed: ParsedCli): RecordMemoryUsageInput {
  return {
    event: {
      id: optionString(parsed.options, "id") ?? `usage:${Date.now()}`,
      sessionId,
      kind: optionString(parsed.options, "kind") ?? "usage-proof-unavailable",
      at: optionString(parsed.options, "at") ?? new Date().toISOString(),
      memoryId: optionString(parsed.options, "memory-id"),
      contextPackId: optionString(parsed.options, "context-pack-id"),
      state: optionString(parsed.options, "state") ?? "unverifiable",
      proof: optionString(parsed.options, "proof"),
      reason: optionString(parsed.options, "reason")
    } as RecordMemoryUsageInput["event"]
  };
}

function ingestEventInput(sessionId: string, parsed: ParsedCli): RecordMemoryIngestInput {
  return {
    event: {
      id: optionString(parsed.options, "id") ?? `ingest:${Date.now()}`,
      sessionId,
      kind: optionString(parsed.options, "kind") ?? "ingest-skipped",
      at: optionString(parsed.options, "at") ?? new Date().toISOString(),
      memoryId: optionString(parsed.options, "memory-id"),
      state: optionString(parsed.options, "state") ?? "skipped",
      reason: optionString(parsed.options, "reason")
    } as RecordMemoryIngestInput["event"]
  };
}

function exportInput(parsed: ParsedCli): ExportBundleInput {
  return {
    planes: optionList(parsed.options, "plane") as ExportBundleInput["planes"],
    scopeIds: optionList(parsed.options, "scope-id"),
    includeSessions: optionBoolean(parsed.options, "include-sessions")
  };
}

async function ingestInput(parsed: ParsedCli): Promise<IngestMemoryInput> {
  const json = await optionalJsonInput(parsed);
  if (json !== undefined) {
    const record = asRecord(json);
    return "memory" in record ? record as unknown as IngestMemoryInput : { memory: json as MemoryObject };
  }
  return memoryFromOptions(parsed);
}

function memoryFromOptions(parsed: ParsedCli): IngestMemoryInput {
  const summary = requiredOption(parsed.options, "summary");
  const now = new Date().toISOString();
  const id = optionString(parsed.options, "id") ?? `memory:${Date.now()}`;
  const evidenceId = optionString(parsed.options, "evidence-id") ?? `evidence:${id}`;
  const source = {
    id: optionString(parsed.options, "source-id") ?? "source:cli",
    type: optionString(parsed.options, "source-type") ?? "operator",
    ref: optionString(parsed.options, "source-ref") ?? "cli",
    actor: optionString(parsed.options, "actor") ?? "operator",
    observedAt: now
  } as NonNullable<MemoryObject["source"]>;
  const memory: MemoryObject = {
    id,
    plane: optionString(parsed.options, "plane") ?? "project-local",
    scopeId: optionString(parsed.options, "scope-id") ?? "local",
    kind: optionString(parsed.options, "kind") ?? "fact",
    durability: optionString(parsed.options, "durability") ?? "durable",
    lifecycle: optionString(parsed.options, "lifecycle") ?? "accepted",
    content: {
      summary,
      body: optionString(parsed.options, "body") ?? summary
    },
    facets: [],
    source,
    evidenceIds: [evidenceId],
    confidence: optionNumber(parsed.options, "confidence") ?? 0.8,
    strength: optionNumber(parsed.options, "strength") ?? 0.5,
    createdAt: now,
    tags: optionList(parsed.options, "tag") ?? []
  } as MemoryObject;
  const evidence: Evidence = {
    id: evidenceId,
    type: "operator-statement",
    source,
    summary: optionString(parsed.options, "evidence-summary") ?? `CLI operator statement for ${id}.`,
    payload: {
      memoryId: id,
      summary,
      body: optionString(parsed.options, "body") ?? summary
    },
    createdAt: now,
    confidence: optionNumber(parsed.options, "evidence-confidence") ?? 1
  };
  return { memory, evidence: [evidence] };
}

function inspectorInfo(
  parsed: ParsedCli,
  dataDir: string | undefined,
  dataPath: string | undefined
): unknown {
  const host = optionString(parsed.options, "host") ?? "127.0.0.1";
  const port = optionNumber(parsed.options, "port") ?? 8787;
  return {
    dataPath: resolveSoulMemoryDataPath({ dataDir, dataPath }),
    inspectorUrl: `http://${host}:${port}/`
  };
}

function commandMcp(
  parsed: ParsedCli,
  dataDir: string | undefined,
  dataPath: string | undefined
): unknown {
  const subcommand = parsed.positionals[0] ?? "config";
  if (subcommand !== "config") {
    throw new Error(`Unknown mcp subcommand '${subcommand}'.`);
  }
  const serverName = optionString(parsed.options, "name") ?? "soul-memory";
  const resolvedDataPath = resolveSoulMemoryDataPath({ dataDir, dataPath });
  const mcpEntrypoint = fileURLToPath(new URL("../mcp/index.js", import.meta.url));
  return {
    agent: optionString(parsed.options, "agent") ?? "generic",
    mcpServers: {
      [serverName]: {
        command: process.execPath,
        args: [mcpEntrypoint],
        env: {
          SOUL_MEMORY_DATA: resolvedDataPath
        }
      }
    }
  };
}

async function optionalJsonInput(parsed: ParsedCli): Promise<unknown | undefined> {
  const inline = optionString(parsed.options, "json");
  if (inline !== undefined) {
    return JSON.parse(inline) as unknown;
  }
  const file = optionString(parsed.options, "file");
  if (file !== undefined) {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  }
  if (process.stdin.isTTY) {
    return undefined;
  }
  const input = await readStdin();
  return input.trim().length === 0 ? undefined : JSON.parse(input) as unknown;
}

async function jsonInput(parsed: ParsedCli): Promise<unknown> {
  const input = await optionalJsonInput(parsed);
  if (input === undefined) {
    throw new Error("--json, --file, or stdin JSON is required.");
  }
  return input;
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return text;
}

async function runCommand(
  command: readonly string[],
  extraEnv: Readonly<Record<string, string>>
): Promise<{ readonly command: readonly string[]; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }> {
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new Error("gateway command is empty.");
  }
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv }
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return { command, ...result };
}

function parseCli(argv: readonly string[]): ParsedCli {
  const dashIndex = argv.indexOf("--");
  const beforeDash = dashIndex === -1 ? [...argv] : argv.slice(0, dashIndex);
  const commandAfterDash = dashIndex === -1 ? [] : argv.slice(dashIndex + 1);
  const { positionals, options } = extractOptions(beforeDash);
  return {
    command: positionals[0] ?? "help",
    positionals: positionals.slice(1),
    options,
    commandAfterDash
  };
}

function extractOptions(tokens: readonly string[]): { positionals: string[]; options: Map<string, string | boolean> } {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      options.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(withoutPrefix, next);
      index += 1;
    } else {
      options.set(withoutPrefix, true);
    }
  }
  return { positionals, options };
}

function optionString(options: ReadonlyMap<string, string | boolean>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === "string" ? value : undefined;
}

function requiredOption(options: ReadonlyMap<string, string | boolean>, key: string): string {
  const value = optionString(options, key);
  if (value === undefined || value.length === 0) {
    throw new Error(`--${key} is required.`);
  }
  return value;
}

function optionNumber(options: ReadonlyMap<string, string | boolean>, key: string): number | undefined {
  const value = optionString(options, key);
  return value === undefined ? undefined : Number(value);
}

function optionBoolean(options: ReadonlyMap<string, string | boolean>, key: string): boolean | undefined {
  const value = options.get(key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "true" || value === "1" || value === "yes";
  }
  return undefined;
}

function optionList(options: ReadonlyMap<string, string | boolean>, key: string): string[] | undefined {
  const value = optionString(options, key);
  if (value === undefined) {
    return undefined;
  }
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length === 0 ? undefined : items;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function printHelp(): void {
  process.stdout.write(`soul-memory commands:
  setup --data-dir <dir>
  doctor
  serve [--host 127.0.0.1] [--port 8787]
  ingest --summary <text> [--json <json> | --file <path>]
  recall --query <text>
  context --query <text> [--session-id <id>]
  session start|get|finish|context|usage|ingest|violations
  govern accept|reject|retire|mark-sensitive <memory-id> --reason <text>
  mcp config [--agent codex] [--name soul-memory]
  export [--file <path>]
  import --file <path>
  backup --path <path>
  gateway --query <text> -- <command>
  inspector [--host 127.0.0.1] [--port 8787]
`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSoulMemoryCli().catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
    process.exitCode = 1;
  });
}
