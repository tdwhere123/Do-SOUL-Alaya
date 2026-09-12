import { readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ListDirectoryToolInput, ReadFileToolInput, SearchFilesToolInput } from "@do-soul/alaya-protocol";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_RESULTS } from "./tool-runtime-file-constants.js";
import {
  createAccessDenied,
  createFileToolError,
  mapFileSystemError,
  resolveContainedPath,
  resolveRealWritableRoots
} from "./tool-runtime-file-common.js";
import { containedFdPath, openContained } from "./open-contained.js";

export async function readFile(
  input: ReadFileToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
  const maxBytes =
    Number.isInteger(input.maxBytes) && (input.maxBytes as number) > 0
      ? (input.maxBytes as number)
      : DEFAULT_MAX_BYTES;
  const opened = await openContained(input.path, writableRoots, "file", {
    basePath: writableRoots[0]
  });
  if (!opened.ok) {
    return opened;
  }
  try {
    return await readOpenedRegularFile(opened.handle, maxBytes);
  } catch (error) {
    return mapFileSystemError(error, opened.realPath);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function listDirectory(
  input: ListDirectoryToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
  const opened = await openContained(input.path, writableRoots, "directory", {
    basePath: writableRoots[0]
  });
  if (!opened.ok) {
    return opened;
  }
  try {
    const entries = await readdir(containedFdPath(opened.handle, opened.realPath), { withFileTypes: true });
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
    return mapFileSystemError(error, opened.realPath);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function searchFiles(
  input: SearchFilesToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
  const opened = await openContained(input.baseDir, writableRoots, "directory", {
    basePath: writableRoots[0]
  });
  if (!opened.ok) {
    return opened;
  }
  await opened.handle.close().catch(() => undefined);

  if (!isPatternSupported(input.pattern)) {
    return createAccessDenied("Pattern is outside the workspace boundary.");
  }

  const realWritableRoots = await resolveRealWritableRoots(writableRoots);
  const containmentRoots = realWritableRoots.length > 0 ? realWritableRoots : writableRoots;
  if (patternEscapesWorkspace(input.pattern, opened.realPath, containmentRoots)) {
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
    await walkFiles(opened.realPath, containmentRoots, async (absolutePath, relativePath) => {
      const normalizedRelative = relativePath.split(path.sep).join("/");
      if (!patternRegex.test(normalizedRelative)) {
        return;
      }

      const containedMatch = resolveContainedPath(absolutePath, containmentRoots);
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
    return mapFileSystemError(error, opened.realPath);
  }
}

async function readOpenedRegularFile(handle: FileHandle, maxBytes: number): Promise<unknown> {
  const stat = await handle.stat();
  if (stat.size > maxBytes) {
    return createFileToolError("SIZE_EXCEEDED", `File exceeds the ${maxBytes}-byte limit.`);
  }
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
  return {
    ok: true,
    content: Buffer.concat(chunks, totalBytesRead).toString("utf8"),
    bytesRead: totalBytesRead
  };
}

async function walkFiles(
  root: string,
  writableRoots: readonly string[],
  visit: (absolutePath: string, relativePath: string) => Promise<void>
): Promise<void> {
  const mutableQueue = [root];
  while (mutableQueue.length > 0) {
    const current = mutableQueue.shift();
    if (current === undefined) {
      break;
    }
    const opened = await openContained(current, writableRoots, "directory");
    if (!opened.ok) {
      continue;
    }
    try {
      const entries = await readdir(containedFdPath(opened.handle, opened.realPath), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name === "." || entry.name === "..") {
          continue;
        }
        const absolute = path.join(opened.realPath, entry.name);
        if (entry.isDirectory()) {
          mutableQueue.push(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        await visit(absolute, path.relative(root, absolute));
      }
    } finally {
      await opened.handle.close().catch(() => undefined);
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
