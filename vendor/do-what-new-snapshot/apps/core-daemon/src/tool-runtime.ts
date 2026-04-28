import { CoreError, type ConversationToolExecutor, type ToolSpecService } from "@do-what/core";
import {
  ExecShellToolInputSchema,
  ExecShellToolResultSchema,
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
} from "@do-what/protocol";
import { execShell, listDirectory, readFile, searchFiles, writeFile } from "@do-what/engine-gateway";
import { isBuiltinConversationToolId } from "./builtin-conversation-tool-specs.js";
import {
  getWorkspaceGitBindingStatus,
  type GitBindingValidationOptions
} from "./git-binding/validator.js";

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
type ConversationToolExecutorPort = Pick<ConversationToolExecutor, "execute">;
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
  }): Promise<unknown>;
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
): Promise<unknown> {
  return await executeValidatedConversationTool(validateConversationToolInput(toolId, input), writableRoots);
}

export async function executeConversationToolOrThrow(
  toolId: string,
  input: unknown,
  writableRoots: readonly string[]
): Promise<unknown> {
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
): Promise<unknown> {
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
): Promise<unknown> {
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
    handler: async (context, rawInput) =>
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

  const status = await getWorkspaceGitBindingStatus(repoPath, gitBindingValidation);
  if (status.status !== "bound" || status.repo_path === null) {
    return undefined;
  }

  return [status.repo_path];
}
