import fs from "node:fs/promises";
import fsSync, { type Dirent } from "node:fs";
import path from "node:path";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".DS_Store",
]);

/** Returns true for any file matching known lock file patterns (*.lock, *-lock.*). */
function isLockFile(name: string): boolean {
  if (name.endsWith(".lock")) return true;
  // package-lock.json, yarn-error.log-lock, etc.
  if (name.includes("-lock.")) return true;
  return false;
}

function isExcludedFile(name: string): boolean {
  return EXCLUDED_FILE_NAMES.has(name) || isLockFile(name);
}

const MAX_LINES = 100;
const MAX_TOTAL_CHARS = 4000;
const KEY_FILE_CHAR_LIMIT = 500;
// Traverse up to 3 levels deep: root = level 0, files at level 3 are included.
// We start recursion at depth 0 (root's direct children). The check `depth < MAX_DEPTH`
// controls when we recurse into sub-directories. With MAX_DEPTH = 3 and initial depth = 0:
//   - depth 0: root children (show + recurse)
//   - depth 1: children of those (show + recurse)
//   - depth 2: children of those (show + recurse)
//   - depth 3: children of those (show files, NO further recursion)
const MAX_DEPTH = 3;
// Sentinel value: collect one extra line to detect overflow without a second pass
const COLLECT_LIMIT = MAX_LINES + 1;

/**
 * Recursively collects file tree lines up to MAX_DEPTH levels deep.
 * Collects at most COLLECT_LIMIT lines so the caller can detect truncation.
 */
async function collectTreeLines(dirPath: string, depth: number, lines: string[]): Promise<void> {
  if (lines.length >= COLLECT_LIMIT) return;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
    // Sort entries for deterministic order
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }

  for (const entry of entries) {
    if (lines.length >= COLLECT_LIMIT) return;

    // Skip symlinks — do not follow them to avoid escaping the workspace root
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${entry.name}/`);
      if (depth < MAX_DEPTH) {
        await collectTreeLines(path.join(dirPath, entry.name), depth + 1, lines);
      }
    } else {
      if (isExcludedFile(entry.name)) continue;
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${entry.name}`);
    }
  }
}

/**
 * Builds a file tree string for the given rootPath.
 * Returns "" for empty string, nonexistent, or non-directory paths.
 */
export async function buildFileTree(rootPath: string): Promise<string> {
  if (!rootPath) return "";

  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) return "";
  } catch {
    return "";
  }

  const lines: string[] = [];
  await collectTreeLines(rootPath, 0, lines);

  if (lines.length === 0) return "";

  // If we collected more than MAX_LINES, there were additional entries beyond the limit
  if (lines.length > MAX_LINES) {
    return lines.slice(0, MAX_LINES).join("\n") + "\n... (truncated)";
  }

  return lines.join("\n");
}

/**
 * Reads key project files (README.md, package.json, CLAUDE.md) and returns
 * a formatted string with their first 500 characters each.
 */
export async function buildKeyFileSummaries(rootPath: string): Promise<string> {
  const keyFiles = ["README.md", "package.json", "CLAUDE.md", "AGENTS.md"];
  const sections: string[] = [];
  const resolvedRoot = path.resolve(rootPath);

  for (const fileName of keyFiles) {
    const filePath = path.join(resolvedRoot, fileName);
    // Ensure the resolved path stays within the workspace root (defense-in-depth)
    if (!filePath.startsWith(resolvedRoot + path.sep) && filePath !== resolvedRoot) continue;

    let content: string;
    try {
      // Reject symlinks to prevent reading arbitrary host files via symlinked key files
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) continue;
      content = await fs.readFile(filePath, "utf8");
    } catch {
      // File missing or unreadable — skip silently
      continue;
    }

    let excerpt = content.slice(0, KEY_FILE_CHAR_LIMIT);
    if (content.length > KEY_FILE_CHAR_LIMIT) {
      excerpt += "... (truncated)";
    }

    sections.push(`#### ${fileName}\n${excerpt}`);
  }

  return sections.join("\n\n");
}

/**
 * Combines file tree and key file summaries into a ## Workspace Context section.
 * Returns "" for empty or invalid rootPath.
 * Total output is capped at MAX_TOTAL_CHARS characters.
 */
export async function buildWorkspaceContext(rootPath: string): Promise<string> {
  if (!rootPath) return "";
  // Reject relative paths to prevent traversal via rootPath like "../../etc"
  if (!path.isAbsolute(rootPath)) return "";

  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) return "";
  } catch {
    return "";
  }

  const [tree, summaries] = await Promise.all([
    buildFileTree(rootPath),
    buildKeyFileSummaries(rootPath)
  ]);

  const result =
    `## Workspace Context\n\n### File Tree\n${tree}\n\n### Key Files\n${summaries}`;

  if (result.length > MAX_TOTAL_CHARS) {
    // Truncate at last newline before limit to avoid mid-line cutoff
    const truncated = result.slice(0, MAX_TOTAL_CHARS);
    const lastNewline = truncated.lastIndexOf('\n');
    return truncated.slice(0, lastNewline) + "\n... (truncated)";
  }

  return result;
}

/**
 * Synchronous stat check — used only for the path existence guard in buildWorkspaceContext.
 * Kept separate so the async path can use fs.stat throughout.
 * @internal
 */
export function rootPathExistsSync(rootPath: string): boolean {
  if (!rootPath || !path.isAbsolute(rootPath)) return false;
  try {
    return fsSync.statSync(rootPath).isDirectory();
  } catch {
    return false;
  }
}
