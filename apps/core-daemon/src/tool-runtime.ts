import { execFile } from "node:child_process";
import {
  lstat,
  open,
  readFile as fsReadFile,
  readdir,
  realpath,
  writeFile as fsWriteFile
} from "node:fs/promises";
import path from "node:path";
import { CoreError, type ToolSpecService } from "@do-soul/alaya-core";
import {
  ExecShellToolInputSchema,
  ExecShellToolResultSchema,
  type FileToolError,
  type FileToolErrorCode,
  ListDirectoryToolInputSchema,
  ListDirectoryToolResultSchema,
  ReadFileToolInputSchema,
  ReadFileToolResultSchema,
  SearchFilesToolInputSchema,
  SearchFilesToolResultSchema,
  WriteFileToolInputSchema,
  WriteFileToolResultSchema,
  type ConversationRuntimeContext,
  type ExecShellToolInput,
  type ListDirectoryToolInput,
  type ReadFileToolInput,
  type SearchFilesToolInput,
  type ToolSpec,
  type ToolUseBlock,
  type WriteFileToolInput
} from "@do-soul/alaya-protocol";
import { isBuiltinConversationToolId } from "./builtin-conversation-tool-specs.js";

const AFFECTED_PATH_WRITE_TOOL_IDS = new Set([
  "tools.write_file",
  "mcp__filesystem__write_file"
]);

type ToolSchemaIssue = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

type SafeParseSchema<TOutput> = {
  safeParse(value: unknown):
    | { success: true; data: TOutput }
    | { success: false; error: { issues: readonly ToolSchemaIssue[] } };
};

export type ToolResultBlock = {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
};

type StructuredToolErrorResult = {
  readonly ok: false;
  readonly code?: string;
  readonly message?: string;
  readonly [key: string]: unknown;
};

type ConversationWorkspaceRepo = {
  getById(id: string): Promise<{
    readonly root_path: string;
    readonly repo_path?: string | null;
  } | null>;
};

type ConversationToolSpecService = Pick<ToolSpecService, "findById" | "register" | "update">;
type ConversationToolExecutionContext = Readonly<{
  readonly writableRoots: readonly string[];
}>;

type ConversationToolExecutionRequest = Readonly<{
  readonly toolId: string;
  readonly rawInput: unknown;
  readonly runtimeContext: Readonly<ConversationRuntimeContext>;
  readonly workspaceRoot: string;
  readonly affectedPathRoots?: readonly string[];
  readonly handler: (
    context: ConversationToolExecutionContext,
    rawInput?: unknown
  ) => Promise< unknown>;
}>;

type ConversationToolExecutionResponse = Readonly<{
  readonly result: unknown;
}>;

type ConversationToolExecutorPort = Readonly<{
  execute(request: ConversationToolExecutionRequest): Promise<ConversationToolExecutionResponse>;
}>;

export interface GitBindingValidationOptions {
  readonly currentWorkingDirectory?: string;
}
type ValidatedBuiltinConversationToolCall =
  | {
    readonly toolId: "tools.read_file";
    readonly input: ReadFileToolInput;
  }
  | {
    readonly toolId: "tools.list_directory";
    readonly input: ListDirectoryToolInput;
  }
  | {
    readonly toolId: "tools.search_files";
    readonly input: SearchFilesToolInput;
  }
  | {
    readonly toolId: "tools.write_file";
    readonly input: WriteFileToolInput;
  }
  | {
    readonly toolId: "tools.exec_shell";
    readonly input: ExecShellToolInput;
  };

export interface ExternalConversationToolExecutor {
  hasTool(toolId: string): boolean;
  refreshTools?(): Promise<void>;
  executeTool(input: {
    readonly toolId: string;
    readonly rawInput: unknown;
    readonly runtimeContext: Readonly<ConversationRuntimeContext>;
    readonly writableRoots: readonly string[];
  }): Promise< unknown>;
}

export async function registerConversationToolSpecs(
  service: ConversationToolSpecService,
  specs: readonly Readonly<ToolSpec>[]
): Promise<void> {
  const uniqueSpecs = dedupeToolSpecs(specs);
  const writePlans = await Promise.all(
    uniqueSpecs.map(async (spec) => {
      try {
        await service.findById(spec.tool_id);
        return { spec, writeKind: "update" as const };
      } catch (error) {
        if (error instanceof CoreError && error.code === "NOT_FOUND") {
          return { spec, writeKind: "register" as const };
        }

        throw error;
      }
    })
  );

  await Promise.all(
    writePlans.map(async (plan) => {
      if (plan.writeKind === "register") {
        await service.register(plan.spec);
        return;
      }

      await service.update(plan.spec);
    })
  );
}

export async function handleConversationToolUse(
  toolUse: ToolUseBlock,
  runtimeContext: Readonly<ConversationRuntimeContext> | undefined,
  workspaceRepo: ConversationWorkspaceRepo,
  conversationToolExecutor: ConversationToolExecutorPort,
  options: {
    readonly externalToolExecutor?: ExternalConversationToolExecutor;
    readonly gitBindingValidation?: GitBindingValidationOptions;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  } = {}
): Promise<ToolResultBlock> {
  const builtinTool = isBuiltinConversationToolId(toolUse.name);

  if (runtimeContext === undefined) {
    return createToolErrorResult(
      toolUse.id,
      "Runtime context is required for MCP tool execution."
    );
  }

  try {
    const workspace = await workspaceRepo.getById(runtimeContext.workspace_id);

    if (workspace === null) {
      return createToolErrorResult(
        toolUse.id,
        `Workspace ${runtimeContext.workspace_id} was not found for tool execution.`
      );
    }

    const affectedPathRoots = shouldResolveAffectedPathRoots(toolUse.name)
      ? await resolveAffectedPathRoots(workspace.repo_path, options.gitBindingValidation)
      : undefined;

    const execution = await executeExternalConversationTool({
      conversationToolExecutor,
      externalToolExecutor: options.externalToolExecutor,
      toolUse,
      runtimeContext,
      workspaceRoot: workspace.root_path,
      affectedPathRoots,
      warn: options.warn ?? defaultWarn
    });

    return createConversationToolResult(toolUse.id, execution.result, { isBuiltinTool: builtinTool });
  } catch (error) {
    if (error instanceof StructuredToolExecutionError) {
      return createConversationToolResult(toolUse.id, error.result, { isBuiltinTool: builtinTool });
    }

    return createToolErrorResult(toolUse.id, readErrorMessage(error, { isBuiltinTool: builtinTool }));
  }
}

export async function executeConversationTool(
  toolId: string,
  input: unknown,
  writableRoots: readonly string[]
): Promise< unknown> {
  return await executeValidatedConversationTool(validateConversationToolInput(toolId, input), writableRoots);
}

export async function executeConversationToolOrThrow(
  toolId: string,
  input: unknown,
  writableRoots: readonly string[]
): Promise< unknown> {
  const result = await executeConversationTool(toolId, input, writableRoots);

  if (isStructuredToolError(result)) {
    throw new StructuredToolExecutionError(result);
  }

  return result;
}

export function validateConversationToolInput(toolId: string, value: unknown): ValidatedBuiltinConversationToolCall {
  switch (toolId) {
    case "tools.read_file":
      return {
        toolId,
        input: parseToolInput(toolId, ReadFileToolInputSchema, value)
      };
    case "tools.list_directory":
      return {
        toolId,
        input: parseToolInput(toolId, ListDirectoryToolInputSchema, value)
      };
    case "tools.search_files":
      return {
        toolId,
        input: parseToolInput(toolId, SearchFilesToolInputSchema, value)
      };
    case "tools.write_file":
      return {
        toolId,
        input: parseToolInput(toolId, WriteFileToolInputSchema, value)
      };
    case "tools.exec_shell":
      return {
        toolId,
        input: parseToolInput(toolId, ExecShellToolInputSchema, value)
      };
    default:
      throw new Error(`Unsupported tool: ${toolId}`);
  }
}

export function parseToolInput<TOutput>(
  toolId: string,
  schema: SafeParseSchema<TOutput>,
  value: unknown
): TOutput {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new Error(`Invalid input for ${toolId}: ${formatSchemaIssues(parsed.error.issues)}`);
  }

  return parsed.data;
}

export function parseToolResult<TOutput>(
  toolId: string,
  schema: SafeParseSchema<TOutput>,
  value: unknown
): TOutput {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new Error(`Invalid result for ${toolId}: ${formatSchemaIssues(parsed.error.issues)}`);
  }

  return parsed.data;
}

export function createToolResult(toolUseId: string, result: unknown): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(result),
    ...(isStructuredToolError(result) ? { is_error: true } : {})
  };
}

function createConversationToolResult(
  toolUseId: string,
  result: unknown,
  options: {
    readonly isBuiltinTool: boolean;
  }
): ToolResultBlock {
  return createToolResult(toolUseId, options.isBuiltinTool ? result : sanitizeExternalToolResult(result));
}

export function createToolErrorResult(toolUseId: string, message: string): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify({ error: message }),
    is_error: true
  };
}

export function isStructuredToolError(result: unknown): result is StructuredToolErrorResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    (result as { readonly ok?: unknown }).ok === false
  );
}

export function readErrorMessage(
  error: unknown,
  options: {
    readonly isBuiltinTool: boolean;
  }
): string {
  if (options.isBuiltinTool) {
    return error instanceof Error ? error.message : "Tool execution failed.";
  }

  if (error instanceof CoreError && error.code === "VALIDATION") {
    return "Invalid MCP tool payload.";
  }

  if (error instanceof Error && error.message.startsWith("Unsupported tool: ")) {
    return error.message;
  }

  return "MCP tool execution failed.";
}

async function executeValidatedConversationTool(
  validatedCall: ValidatedBuiltinConversationToolCall,
  writableRoots: readonly string[]
): Promise< unknown> {
  switch (validatedCall.toolId) {
    case "tools.read_file": {
      const result = await readFile(validatedCall.input, writableRoots);
      return parseToolResult(validatedCall.toolId, ReadFileToolResultSchema, result);
    }
    case "tools.list_directory": {
      const result = await listDirectory(validatedCall.input, writableRoots);
      return parseToolResult(validatedCall.toolId, ListDirectoryToolResultSchema, result);
    }
    case "tools.search_files": {
      const result = await searchFiles(validatedCall.input, writableRoots);
      return parseToolResult(validatedCall.toolId, SearchFilesToolResultSchema, result);
    }
    case "tools.write_file": {
      const result = await writeFile(validatedCall.input, writableRoots);
      return parseToolResult(validatedCall.toolId, WriteFileToolResultSchema, result);
    }
    case "tools.exec_shell": {
      const result = await execShell(validatedCall.input, writableRoots);
      return parseToolResult(validatedCall.toolId, ExecShellToolResultSchema, result);
    }
  }
}

async function executeValidatedConversationToolOrThrow(
  validatedCall: ValidatedBuiltinConversationToolCall,
  writableRoots: readonly string[]
): Promise< unknown> {
  const result = await executeValidatedConversationTool(validatedCall, writableRoots);

  if (isStructuredToolError(result)) {
    throw new StructuredToolExecutionError(result);
  }

  return result;
}

class StructuredToolExecutionError extends Error {
  public constructor(public readonly result: StructuredToolErrorResult) {
    super(result.message ?? "Structured tool execution failed.");
    this.name = "StructuredToolExecutionError";
  }
}

function sanitizeExternalToolResult(result: unknown): unknown {
  if (!isStructuredToolError(result)) {
    return result;
  }

  return sanitizeExternalStructuredToolError(result);
}

function sanitizeExternalStructuredToolError(result: StructuredToolErrorResult): StructuredToolErrorResult {
  return Object.freeze({
    ok: false,
    ...(result.code === undefined ? {} : { code: result.code }),
    message: publicMessageForExternalStructuredToolError(result)
  });
}

function publicMessageForExternalStructuredToolError(result: StructuredToolErrorResult): string {
  if (typeof result.code === "string" && result.code.includes("VALIDATION")) {
    return "Invalid MCP tool payload.";
  }

  return "MCP tool execution failed.";
}

function formatSchemaIssues(issues: readonly ToolSchemaIssue[]): string {
  return issues
    .map((issue) => {
      const location = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${String(location)}: ${issue.message}`;
    })
    .join("; ");
}

async function executeExternalConversationTool(input: {
  readonly conversationToolExecutor: ConversationToolExecutorPort;
  readonly externalToolExecutor: ExternalConversationToolExecutor | undefined;
  readonly toolUse: ToolUseBlock;
  readonly runtimeContext: Readonly<ConversationRuntimeContext>;
  readonly workspaceRoot: string;
  readonly affectedPathRoots?: readonly string[];
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}) {
  if (input.externalToolExecutor === undefined) {
    throw new Error(`Unsupported tool: ${input.toolUse.name}`);
  }
  const builtinTool = isBuiltinConversationToolId(input.toolUse.name);
  const validatedInput = builtinTool
    ? validateConversationToolInput(input.toolUse.name, input.toolUse.input).input
    : input.toolUse.input;
  const externalToolExecutor = input.externalToolExecutor;
  if (!externalToolExecutor.hasTool(input.toolUse.name)) {
    if (externalToolExecutor.refreshTools !== undefined) {
      await externalToolExecutor.refreshTools().catch((error) => {
        input.warn("failed to refresh external conversation tool discovery", {
          toolId: input.toolUse.name,
          error
        });
      });
    }

    if (!externalToolExecutor.hasTool(input.toolUse.name)) {
      throw new Error(`Unsupported tool: ${input.toolUse.name}`);
    }
  }

  return await input.conversationToolExecutor.execute({
    toolId: input.toolUse.name,
    rawInput: validatedInput,
    runtimeContext: input.runtimeContext,
    workspaceRoot: input.workspaceRoot,
    affectedPathRoots: input.affectedPathRoots,
    handler: async (context: ConversationToolExecutionContext, rawInput?: unknown) =>
      await externalToolExecutor.executeTool({
        toolId: input.toolUse.name,
        rawInput: builtinTool ? validatedInput : (rawInput ?? validatedInput),
        runtimeContext: input.runtimeContext,
        writableRoots: context.writableRoots
      })
  });
}
function dedupeToolSpecs(specs: readonly Readonly<ToolSpec>[]): readonly Readonly<ToolSpec>[] {
  const byId = new Map<string, Readonly<ToolSpec>>();
  for (const spec of specs) {
    byId.set(spec.tool_id, spec);
  }

  return [...byId.values()];
}

function defaultWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(message, meta);
}

function shouldResolveAffectedPathRoots(toolId: string): boolean {
  return AFFECTED_PATH_WRITE_TOOL_IDS.has(toolId);
}

async function resolveAffectedPathRoots(
  repoPath: string | null | undefined,
  gitBindingValidation: GitBindingValidationOptions | undefined
): Promise<readonly string[] | undefined> {
  if (repoPath === undefined || repoPath === null) {
    return undefined;
  }

  const status = await resolveWorkspaceGitBindingStatus(repoPath, gitBindingValidation);
  if (status.status !== "bound") {
    return undefined;
  }

  return [status.repo_path];
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_OUTPUT_BYTES = 131_072;
const MAX_EXEC_BUFFER_BYTES = MAX_EXEC_OUTPUT_BYTES * 10;
const EXEC_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_ENV",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT"
] as const;

type FileSystemEntryResult =
  | { readonly ok: true; readonly stats: Awaited<ReturnType<typeof lstat>> }
  | FileToolError;

type WorkspaceGitBindingStatus =
  | Readonly<{ readonly status: "bound"; readonly repo_path: string }>
  | Readonly<{ readonly status: "unbound"; readonly reason: string }>;

function createAccessDenied(message: string): FileToolError {
  return {
    ok: false,
    code: "ACCESS_DENIED",
    message
  };
}

function createFileToolError(code: FileToolErrorCode, message: string): FileToolError {
  return {
    ok: false,
    code,
    message
  };
}

function resolveContainedPath(
  inputPath: string,
  writableRoots: readonly string[],
  options: {
    readonly basePath?: string;
  } = {}
): { readonly ok: true; readonly resolvedPath: string } | FileToolError {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return createFileToolError("READ_ERROR", "Path is required.");
  }

  if (inputPath.includes("\0")) {
    return createFileToolError("READ_ERROR", "Path must not contain null bytes.");
  }

  if (writableRoots.length === 0) {
    return createAccessDenied("No writable roots are available for containment checks.");
  }

  const normalizedRoots = writableRoots.map((root) => path.resolve(root));
  const resolvedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(options.basePath ?? normalizedRoots[0]!, inputPath);

  if (!normalizedRoots.some((root) => isPathWithinRoot(resolvedPath, root))) {
    return createAccessDenied("Path is outside the workspace boundary.");
  }

  return {
    ok: true,
    resolvedPath
  };
}

async function readFileSystemEntry(resolvedPath: string): Promise<FileSystemEntryResult> {
  try {
    const stats = await lstat(resolvedPath);

    if (stats.isSymbolicLink()) {
      return createAccessDenied(`Path is a symlink and cannot be accessed: ${resolvedPath}`);
    }

    return {
      ok: true,
      stats
    };
  } catch (error) {
    return mapFileSystemError(error, resolvedPath);
  }
}

function mapFileSystemError(
  error: unknown,
  targetPath: string,
  fallbackCode: Extract<FileToolErrorCode, "READ_ERROR" | "WRITE_ERROR"> = "READ_ERROR"
): FileToolError {
  if (isNodeErrorWithCode(error)) {
    if (error.code === "ENOENT") {
      return createFileToolError("NOT_FOUND", `Path not found: ${targetPath}`);
    }

    if (error.code === "EACCES" || error.code === "EPERM") {
      return createAccessDenied(`Access denied: ${targetPath}`);
    }
  }

  return createFileToolError(
    fallbackCode,
    fallbackCode === "WRITE_ERROR"
      ? `Failed to write path: ${targetPath}`
      : `Failed to read path: ${targetPath}`
  );
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readFile(
  input: ReadFileToolInput,
  writableRoots: readonly string[]
): Promise< unknown> {
  const containedPath = resolveContainedPath(input.path, writableRoots, {
    basePath: writableRoots[0]
  });

  if (!containedPath.ok) {
    return containedPath;
  }

  const maxBytes =
    Number.isInteger(input.maxBytes) && (input.maxBytes as number) > 0
      ? (input.maxBytes as number)
      : DEFAULT_MAX_BYTES;
  const entry = await readFileSystemEntry(containedPath.resolvedPath);

  if (!entry.ok) {
    return entry;
  }

  if (!entry.stats.isFile()) {
    return createFileToolError("READ_ERROR", `Path is not a file: ${containedPath.resolvedPath}`);
  }

  if (entry.stats.size > maxBytes) {
    return createFileToolError("SIZE_EXCEEDED", `File exceeds the ${maxBytes}-byte limit.`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(containedPath.resolvedPath, "r");
    const chunks: Buffer[] = [];
    let totalBytesRead = 0;
    while (totalBytesRead <= maxBytes) {
      const remainingBytes = maxBytes + 1 - totalBytesRead;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }

      totalBytesRead += bytesRead;
      if (totalBytesRead > maxBytes) {
        return createFileToolError("SIZE_EXCEEDED", `File exceeds the ${maxBytes}-byte limit.`);
      }

      chunks.push(chunk.subarray(0, bytesRead));
    }

    const content = Buffer.concat(chunks, totalBytesRead).toString("utf8");
    return {
      ok: true,
      content,
      bytesRead: totalBytesRead
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function listDirectory(
  input: ListDirectoryToolInput,
  writableRoots: readonly string[]
): Promise< unknown> {
  const containedPath = resolveContainedPath(input.path, writableRoots, {
    basePath: writableRoots[0]
  });

  if (!containedPath.ok) {
    return containedPath;
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);
  if (!entry.ok) {
    return entry;
  }

  if (!entry.stats.isDirectory()) {
    return createFileToolError("READ_ERROR", `Path is not a directory: ${containedPath.resolvedPath}`);
  }

  try {
    const entries = await readdir(containedPath.resolvedPath, { withFileTypes: true });
    return {
      ok: true,
      entries: entries
        .map((dirent) => ({
          name: dirent.name,
          isDirectory: dirent.isDirectory()
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath);
  }
}

async function searchFiles(
  input: SearchFilesToolInput,
  writableRoots: readonly string[]
): Promise< unknown> {
  const containedPath = resolveContainedPath(input.baseDir, writableRoots, {
    basePath: writableRoots[0]
  });

  if (!containedPath.ok) {
    return containedPath;
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);
  if (!entry.ok) {
    return entry;
  }

  if (!entry.stats.isDirectory()) {
    return createFileToolError(
      "READ_ERROR",
      `Base directory is not a directory: ${containedPath.resolvedPath}`
    );
  }

  if (!isPatternSupported(input.pattern)) {
    return createAccessDenied("Pattern is outside the workspace boundary.");
  }

  if (patternEscapesWorkspace(input.pattern, containedPath.resolvedPath, writableRoots)) {
    return createAccessDenied("Pattern is outside the workspace boundary.");
  }

  const maxResults =
    Number.isInteger(input.maxResults) && (input.maxResults as number) > 0
      ? (input.maxResults as number)
      : DEFAULT_MAX_RESULTS;
  const patternRegex = globPatternToRegExp(input.pattern);

  try {
    const matches: string[] = [];
    let escapedMatchFound = false;
    await walkFiles(containedPath.resolvedPath, async (absolutePath, relativePath) => {
      const normalizedRelative = relativePath.split(path.sep).join("/");
      if (!patternRegex.test(normalizedRelative)) {
        return;
      }

      const containedMatch = resolveContainedPath(absolutePath, writableRoots);
      if (!containedMatch.ok) {
        escapedMatchFound = true;
        return;
      }

      matches.push(normalizedRelative);
    });

    if (escapedMatchFound) {
      return createAccessDenied("Pattern is outside the workspace boundary.");
    }

    return {
      ok: true,
      paths: matches.sort((left, right) => left.localeCompare(right)).slice(0, maxResults)
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath);
  }
}

async function walkFiles(
  root: string,
  visit: (absolutePath: string, relativePath: string) => Promise<void>
): Promise<void> {
  const queue: readonly string[] = [root];
  const mutableQueue = [...queue];
  while (mutableQueue.length > 0) {
    const current = mutableQueue.shift();
    if (current === undefined) {
      break;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        mutableQueue.push(absolute);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      await visit(absolute, path.relative(root, absolute));
    }
  }
}

function globPatternToRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      expression += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      expression += "[^/]*";
      continue;
    }

    if (char === "?") {
      expression += "[^/]";
      continue;
    }

    expression += escapeRegExpChar(char);
  }

  expression += "$";
  return new RegExp(expression);
}

function escapeRegExpChar(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function isPatternSupported(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    return false;
  }

  if (pattern.includes("\0")) {
    return false;
  }

  if (path.isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern)) {
    return false;
  }

  return true;
}

function patternEscapesWorkspace(
  pattern: string,
  baseDir: string,
  writableRoots: readonly string[]
): boolean {
  const literalPrefix = getLiteralPrefix(pattern);
  if (literalPrefix.length === 0) {
    return false;
  }

  const resolvedPrefix = path.resolve(baseDir, literalPrefix);
  return !resolveContainedPath(resolvedPrefix, writableRoots).ok;
}

function getLiteralPrefix(pattern: string): string {
  const segments = pattern.split(/[\\/]+/);
  const literalSegments: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      literalSegments.push(segment);
      continue;
    }

    if (hasGlobSyntax(segment)) {
      break;
    }

    literalSegments.push(segment);
  }

  return literalSegments.length === 0 ? "" : path.join(...literalSegments);
}

function hasGlobSyntax(segment: string): boolean {
  return /[*?[\]{}()!+@]/.test(segment);
}

async function writeFile(
  input: WriteFileToolInput,
  writableRoots: readonly string[]
): Promise< unknown> {
  const containedPath = resolveContainedPath(input.path, writableRoots);
  if (!containedPath.ok) {
    return containedPath;
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);
  if (!entry.ok && entry.code !== "NOT_FOUND") {
    return entry;
  }

  if (entry.ok && !entry.stats.isFile()) {
    return createFileToolError("WRITE_ERROR", `Path is not a regular file: ${containedPath.resolvedPath}`);
  }

  const parentDirectory = path.dirname(containedPath.resolvedPath);
  const parentEntry = await readFileSystemEntry(parentDirectory);
  if (!parentEntry.ok) {
    return parentEntry;
  }

  if (!parentEntry.stats.isDirectory()) {
    return createFileToolError("WRITE_ERROR", `Parent path is not a directory: ${parentDirectory}`);
  }

  try {
    const realParentDirectory = await realpath(parentDirectory);
    const realWritableRoots = await Promise.all(
      writableRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return path.resolve(root);
        }
      })
    );

    if (!realWritableRoots.some((root) => isPathWithinRoot(realParentDirectory, root))) {
      return createAccessDenied("Path is outside the workspace boundary.");
    }
  } catch (error) {
    return mapFileSystemError(error, parentDirectory, "WRITE_ERROR");
  }

  try {
    const buffer = Buffer.from(input.content, "utf8");
    await fsWriteFile(containedPath.resolvedPath, buffer);
    return {
      ok: true,
      bytesWritten: buffer.byteLength
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath, "WRITE_ERROR");
  }
}

async function execShell(
  input: ExecShellToolInput,
  writableRoots: readonly string[]
): Promise< unknown> {
  if (writableRoots.length === 0) {
    return createAccessDenied("No writable roots are available for exec containment.");
  }

  const timeoutMs = normalizeExecTimeout(input.timeoutMs);
  const cwd = writableRoots[0]!;
  const args = input.args !== undefined ? [...input.args] : [];

  return await new Promise((resolve) => {
    execFile(
      input.command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_EXEC_BUFFER_BYTES,
        env: createExecChildProcessEnv(),
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (error.killed === true) {
            resolve(createFileToolError("TIMEOUT", `Command timed out after ${timeoutMs}ms.`));
            return;
          }

          if (typeof error.code === "number") {
            resolve({
              ok: true,
              exitCode: error.code,
              stdout: truncateExecOutput(stdout),
              stderr: truncateExecOutput(stderr)
            });
            return;
          }

          resolve(createFileToolError("EXEC_ERROR", error.message));
          return;
        }

        resolve({
          ok: true,
          exitCode: 0,
          stdout: truncateExecOutput(stdout),
          stderr: truncateExecOutput(stderr)
        });
      }
    );
  });
}

function normalizeExecTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }

  return Math.min(value, MAX_EXEC_TIMEOUT_MS);
}

function truncateExecOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= MAX_EXEC_OUTPUT_BYTES) {
    return output;
  }

  let collectedBytes = 0;
  const truncatedChars: string[] = [];
  for (const char of output) {
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (collectedBytes + nextBytes > MAX_EXEC_OUTPUT_BYTES) {
      break;
    }

    truncatedChars.push(char);
    collectedBytes += nextBytes;
  }

  return `${truncatedChars.join("")}\n[truncated]`;
}

function createExecChildProcessEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const variableName of EXEC_CHILD_ENV_ALLOWLIST) {
    const value = process.env[variableName];
    if (typeof value === "string" && value.length > 0) {
      childEnv[variableName] = value;
    }
  }

  return childEnv;
}

async function resolveWorkspaceGitBindingStatus(
  repoPath: string,
  _validation: GitBindingValidationOptions | undefined
): Promise<WorkspaceGitBindingStatus> {
  const resolvedRepoPath = path.resolve(repoPath);
  const gitMarkerPath = path.join(resolvedRepoPath, ".git");
  const markerEntry = await readFileSystemEntry(gitMarkerPath);

  if (!markerEntry.ok) {
    return {
      status: "unbound",
      reason: "missing_git_marker"
    };
  }

  if (markerEntry.stats.isDirectory()) {
    return {
      status: "bound",
      repo_path: resolvedRepoPath
    };
  }

  if (!markerEntry.stats.isFile()) {
    return {
      status: "unbound",
      reason: "unsupported_git_marker"
    };
  }

  const gitMarkerContent = await fsReadFile(gitMarkerPath, "utf8").catch(() => null);
  if (gitMarkerContent === null) {
    return {
      status: "unbound",
      reason: "unreadable_git_marker"
    };
  }

  const match = /^\s*gitdir:\s*(.+)\s*$/i.exec(gitMarkerContent);
  if (match === null) {
    return {
      status: "unbound",
      reason: "invalid_git_marker"
    };
  }

  const rawGitDir = match[1]!;
  const resolvedGitDir = path.isAbsolute(rawGitDir)
    ? path.resolve(rawGitDir)
    : path.resolve(resolvedRepoPath, rawGitDir);
  if (!isPathWithinRoot(resolvedGitDir, resolvedRepoPath)) {
    return {
      status: "unbound",
      reason: "gitdir_outside_repo_root"
    };
  }

  return {
    status: "bound",
    repo_path: resolvedRepoPath
  };
}

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
