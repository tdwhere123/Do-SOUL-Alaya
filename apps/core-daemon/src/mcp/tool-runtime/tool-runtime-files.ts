import { throwIfAborted } from "@do-soul/alaya-engine-gateway";
import {
  type ExecShellToolInput,
  type ListDirectoryToolInput,
  type ReadFileToolInput,
  type SearchFilesToolInput,
  type WriteFileToolInput
} from "@do-soul/alaya-protocol";
import { listDirectory, readFile, searchFiles } from "./tool-runtime-file-read-search.js";
import { execShell, writeFile } from "./tool-runtime-file-write-exec.js";
import { validateWorkspaceGitBindingInput } from "../../routes/workspace/git-binding/workspace-git-binding.js";
import type { GitBindingValidationOptions } from "../../routes/workspace/git-binding/workspace-git-binding-types.js";

export type { GitBindingValidationOptions } from "../../routes/workspace/git-binding/workspace-git-binding-types.js";

const AFFECTED_PATH_WRITE_TOOL_IDS = new Set([
  "tools.write_file",
  "mcp__filesystem__write_file"
]);

export type ValidatedBuiltinConversationToolCall =
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

export async function executeBuiltinConversationTool(
  validatedCall: ValidatedBuiltinConversationToolCall,
  writableRoots: readonly string[],
  abortSignal?: AbortSignal
): Promise<unknown> {
  switch (validatedCall.toolId) {
    case "tools.read_file":
      return await readFile(validatedCall.input, writableRoots);
    case "tools.list_directory":
      return await listDirectory(validatedCall.input, writableRoots);
    case "tools.search_files":
      return await searchFiles(validatedCall.input, writableRoots);
    case "tools.write_file":
      throwIfAborted(abortSignal);
      return await writeFile(validatedCall.input, writableRoots);
    case "tools.exec_shell":
      throwIfAborted(abortSignal);
      return await execShell(validatedCall.input, writableRoots);
  }
}

export function shouldResolveAffectedPathRoots(toolId: string): boolean {
  return AFFECTED_PATH_WRITE_TOOL_IDS.has(toolId);
}

export async function resolveAffectedPathRoots(
  repoPath: string | null | undefined,
  gitBindingValidation: GitBindingValidationOptions | undefined
): Promise<readonly string[] | undefined> {
  if (repoPath === undefined || repoPath === null) {
    return undefined;
  }

  const validation = await validateWorkspaceGitBindingInput(repoPath, gitBindingValidation);
  if (!validation.ok) {
    return undefined;
  }

  return [validation.repo_path];
}
