import { open, readdir } from "node:fs/promises";
import path from "node:path";
import type { ListDirectoryToolInput, ReadFileToolInput, SearchFilesToolInput } from "@do-soul/alaya-protocol";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_RESULTS } from "./tool-runtime-file-constants.js";
import {
  createAccessDenied,
  createFileToolError,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath
} from "./tool-runtime-file-common.js";

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function readFile(
  input: ReadFileToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
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

export async function listDirectory(
  input: ListDirectoryToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
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

export async function searchFiles(
  input: SearchFilesToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
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
