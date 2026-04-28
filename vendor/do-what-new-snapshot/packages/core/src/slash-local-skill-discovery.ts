/**
 * Local Claude Code skill/command discovery.
 *
 * Scans ~/.claude/{commands,skills,plugins} and returns DiscoveredSlashCommand records.
 * Does NOT execute commands; just discovers them for the merged index.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiscoveredCommandSource = "user" | "skill" | "plugin" | "sdk";

export interface DiscoveredSlashCommand {
  readonly source: DiscoveredCommandSource;
  /** Human-readable origin label (e.g. "user commands", plugin name, skill name) */
  readonly origin: string;
  /** Canonical slash-prefixed name, e.g. "/learn", "/figma:figma-use" */
  readonly name: string;
  /** Optional display name from frontmatter */
  readonly display_name?: string;
  /** Human-readable description */
  readonly description: string;
  /** Whether the command can be used */
  readonly available: boolean;
  /** Reason why unavailable (only set when available=false) */
  readonly unavailable_reason?: string;
  /** Keywords for palette filtering */
  readonly filter_keywords: readonly string[];
  /** Absolute path to the source file on disk */
  readonly source_path: string;
}

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter extractor
//
// Handles the --- ... --- block format only.
// Returns null for malformed content (caller logs + skips).
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  readonly name?: string;
  readonly display_name?: string;
  readonly description?: string;
  readonly filter_keywords?: readonly string[];
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return {};
  }
  const afterOpen = trimmed.slice(3);
  const closeIndex = afterOpen.indexOf("\n---");
  if (closeIndex === -1) {
    // No closing ---; treat as malformed
    return null;
  }
  const frontmatterText = afterOpen.slice(0, closeIndex);

  try {
    return parseSimpleYaml(frontmatterText);
  } catch {
    return null;
  }
}

/**
 * Minimal YAML parser for simple key: value and key: [a, b] lines.
 * Throws on syntax errors so the caller can treat as malformed.
 */
function parseSimpleYaml(text: string): ParsedFrontmatter {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;

    const colonIdx = trimmedLine.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmedLine.slice(0, colonIdx).trim();
    const rawValue = trimmedLine.slice(colonIdx + 1).trim();

    if (rawValue.startsWith("[")) {
      // Array value: parse ["a", "b"] or [a, b]
      const closeIdx = rawValue.indexOf("]");
      if (closeIdx === -1) {
        // Unclosed bracket — malformed
        throw new Error(`Unclosed bracket in YAML value for key "${key}": ${rawValue}`);
      }
      const inner = rawValue.slice(1, closeIdx);
      const items = inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
      result[key] = items;
    } else {
      // Scalar value: strip optional quotes
      result[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }

  return result as ParsedFrontmatter;
}

// ---------------------------------------------------------------------------
// Safe readdir — returns [] on ENOENT and other non-existence errors
// ---------------------------------------------------------------------------

async function safeReaddir(dirPath: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dirPath);
  } catch (err: unknown) {
    if (isNodeError(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return [];
    }
    return [];
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

// ---------------------------------------------------------------------------
// Scan ~/.claude/commands/*.md  → source: "user"
// ---------------------------------------------------------------------------

async function scanUserCommands(
  commandsDir: string,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<DiscoveredSlashCommand[]> {
  const entries = await safeReaddir(commandsDir);
  const results: DiscoveredSlashCommand[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(commandsDir, entry);
    const baseName = path.basename(entry, ".md");

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      if (fm === null) {
        warn("[slash-discovery] malformed frontmatter in user command, skipping", {
          path: filePath
        });
        continue;
      }

      results.push({
        source: "user",
        origin: "user commands",
        name: normalizeSlashName(baseName),
        display_name: fm.display_name,
        description: fm.description ?? baseName,
        available: true,
        filter_keywords: fm.filter_keywords ?? [],
        source_path: filePath
      });
    } catch (err) {
      warn("[slash-discovery] failed to read user command file, skipping", {
        path: filePath,
        error: String(err)
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scan ~/.claude/skills/<skill>/SKILL.md  → source: "skill"
// ---------------------------------------------------------------------------

async function scanSkillCommands(
  skillsDir: string,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<DiscoveredSlashCommand[]> {
  const entries = await safeReaddir(skillsDir);
  const results: DiscoveredSlashCommand[] = [];

  for (const skillName of entries) {
    const skillMdPath = path.join(skillsDir, skillName, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = await fs.promises.readFile(skillMdPath, "utf-8");
      const fm = parseFrontmatter(content);
      if (fm === null) {
        warn("[slash-discovery] malformed SKILL.md, skipping", {
          path: skillMdPath
        });
        continue;
      }

      // Prefer the frontmatter name; fall back to the directory name.
      const resolvedName = fm.name ?? skillName;

      results.push({
        source: "skill",
        origin: `skill:${skillName}`,
        name: normalizeSlashName(resolvedName),
        display_name: fm.display_name,
        description: fm.description ?? resolvedName,
        available: true,
        filter_keywords: fm.filter_keywords ?? [],
        source_path: skillMdPath
      });
    } catch (err) {
      warn("[slash-discovery] failed to read SKILL.md, skipping", {
        path: skillMdPath,
        error: String(err)
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scan ~/.claude/plugins/<plugin>/commands/*.md  → source: "plugin"
// Scan ~/.claude/plugins/<plugin>/skills/<skill>/SKILL.md  → source: "plugin"
// ---------------------------------------------------------------------------

async function scanPluginCommands(
  pluginsDir: string,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<DiscoveredSlashCommand[]> {
  const pluginEntries = await safeReaddir(pluginsDir);
  const results: DiscoveredSlashCommand[] = [];

  for (const pluginName of pluginEntries) {
    const pluginDir = path.join(pluginsDir, pluginName);

    // Plugin commands: <plugin>/commands/*.md
    const commandsDir = path.join(pluginDir, "commands");
    const cmdEntries = await safeReaddir(commandsDir);

    for (const entry of cmdEntries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(commandsDir, entry);
      const baseName = path.basename(entry, ".md");

      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const fm = parseFrontmatter(content);
        if (fm === null) {
          warn("[slash-discovery] malformed frontmatter in plugin command, skipping", {
            path: filePath
          });
          continue;
        }

        // Derive canonical name: /<plugin>:<command-basename>
        const canonicalName = normalizeSlashName(`${pluginName}:${baseName}`);

        results.push({
          source: "plugin",
          origin: `plugin:${pluginName}`,
          name: canonicalName,
          display_name: fm.display_name,
          description: fm.description ?? baseName,
          available: true,
          filter_keywords: fm.filter_keywords ?? [],
          source_path: filePath
        });
      } catch (err) {
        warn("[slash-discovery] failed to read plugin command file, skipping", {
          path: filePath,
          error: String(err)
        });
      }
    }

    // Plugin skills: <plugin>/skills/<skill>/SKILL.md
    const skillsDir = path.join(pluginDir, "skills");
    const skillEntries = await safeReaddir(skillsDir);

    for (const skillName of skillEntries) {
      const skillMdPath = path.join(skillsDir, skillName, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const content = await fs.promises.readFile(skillMdPath, "utf-8");
        const fm = parseFrontmatter(content);
        if (fm === null) {
          warn("[slash-discovery] malformed SKILL.md in plugin, skipping", {
            path: skillMdPath
          });
          continue;
        }

        // Prefer frontmatter name; fall back to <plugin>:<skill-dir>
        const resolvedName = fm.name ?? `${pluginName}:${skillName}`;

        results.push({
          source: "plugin",
          origin: `plugin:${pluginName}`,
          name: normalizeSlashName(resolvedName),
          display_name: fm.display_name,
          description: fm.description ?? resolvedName,
          available: true,
          filter_keywords: fm.filter_keywords ?? [],
          source_path: skillMdPath
        });
      } catch (err) {
        warn("[slash-discovery] failed to read plugin SKILL.md, skipping", {
          path: skillMdPath,
          error: String(err)
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// normalizeSlashName: ensure leading /
// ---------------------------------------------------------------------------

function normalizeSlashName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

// ---------------------------------------------------------------------------
// Main entry: gather all local discoveries
// ---------------------------------------------------------------------------

/**
 * Gather all local skill/command discoveries from the given homeDir.
 * Returns only filesystem-discovered entries; SDK merging is done in
 * SlashCommandService.discoverLocalSkillCommands.
 */
export async function gatherLocalDiscoveries(
  homeDir: string,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<DiscoveredSlashCommand[]> {
  const claudeDir = path.join(homeDir, ".claude");

  const [userCommands, skillCommands, pluginCommands] = await Promise.all([
    scanUserCommands(path.join(claudeDir, "commands"), warn),
    scanSkillCommands(path.join(claudeDir, "skills"), warn),
    scanPluginCommands(path.join(claudeDir, "plugins"), warn)
  ]);

  return [...userCommands, ...skillCommands, ...pluginCommands];
}
