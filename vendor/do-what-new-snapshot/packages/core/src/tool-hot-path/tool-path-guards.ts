import path from "node:path";
import type { ToolSpec } from "@do-what/protocol";
import { CoreError } from "../errors.js";
import type { ToolExecutionContext } from "../tool-substrate/index.js";

export function assertScopeGuardWithinContext(
  toolSpec: Readonly<ToolSpec>,
  value: unknown,
  context: Readonly<ToolExecutionContext>
): void {
  const allowedRoots = getAllowedRoots(toolSpec.scope_guard, context);

  if (allowedRoots === null) {
    return;
  }

  const pathCandidates = collectPathCandidates(value);

  for (const candidate of pathCandidates) {
    const resolvedCandidate = resolveCandidate(toolSpec.scope_guard, context, candidate);

    if (!isPathAllowed(resolvedCandidate, allowedRoots)) {
      throw new CoreError(
        "VALIDATION",
        `Tool input path violates scope_guard ${toolSpec.scope_guard}`
      );
    }
  }
}

function getAllowedRoots(
  scopeGuard: ToolSpec["scope_guard"],
  context: Readonly<ToolExecutionContext>
): readonly string[] | null {
  switch (scopeGuard) {
    case "global":
      return null;
    case "workspace":
      return context.writableRoots;
    case "worktree":
    case "project":
      return [context.cwd];
  }
}

export function collectPathCandidates(value: unknown, currentKey?: string): string[] {
  if (typeof value === "string") {
    return currentKey !== undefined && isPathLikeKey(currentKey) ? [value] : [];
  }

  if (Array.isArray(value)) {
    const collected: string[] = [];

    for (const item of value) {
      collected.push(...collectPathCandidates(item, currentKey));
    }

    return collected;
  }

  if (value !== null && typeof value === "object") {
    const collected: string[] = [];

    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      collected.push(...collectPathCandidates(nestedValue, nestedKey));
    }

    return collected;
  }

  return [];
}

function resolveCandidate(
  scopeGuard: ToolSpec["scope_guard"],
  context: Readonly<ToolExecutionContext>,
  candidate: string
): string {
  switch (scopeGuard) {
    case "workspace":
      return path.resolve(candidate);
    case "project":
    case "worktree":
      return path.resolve(context.cwd, candidate);
    case "global":
      return path.resolve(candidate);
  }
}

function isPathLikeKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);

  return tokens.some((token) =>
    token === "path" || token === "root" || token === "cwd" || token === "dir" || token === "directory"
  );
}

function isPathAllowed(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const normalizedRoot = path.resolve(root);
    const normalizedCandidate = path.resolve(candidate);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
