import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConversationRuntimeContext } from "@do-soul/alaya-protocol";
import { executeConversationToolOrThrow } from "../../mcp/tool-runtime.js";

const tempDirs = new Set<string>();

export async function cleanupToolRuntimeTempDirs(): Promise<void> {
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
}

export async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dw-tool-runtime-"));
  tempDirs.add(dir);
  return dir;
}

export function trackToolRuntimeTempDir(dir: string): string {
  tempDirs.add(dir);
  return dir;
}

export function createRuntimeContext(): ConversationRuntimeContext {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    user_message_id: "msg-user-1",
    assistant_message_id: "msg-assistant-1"
  };
}

export function createBuiltinToolExecutor(toolIds: readonly string[]) {
  const registeredToolIds = new Set(toolIds);

  return {
    hasTool: (toolId: string) => registeredToolIds.has(toolId),
    executeTool: async ({
      toolId,
      rawInput,
      writableRoots
    }: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly writableRoots: readonly string[];
    }) => await executeConversationToolOrThrow(toolId, rawInput, writableRoots)
  };
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
