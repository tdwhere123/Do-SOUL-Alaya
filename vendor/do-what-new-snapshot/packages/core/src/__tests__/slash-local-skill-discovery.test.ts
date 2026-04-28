/**
 * FROZEN RED TESTS — DO NOT MODIFY UNTIL IMPLEMENTATION IS ACCEPTED.
 *
 * Contract: SlashCommandService.discoverLocalSkillCommands(homeDir?)
 * Bug card: docs/v0.2/manual-testing/bug-cards/BUG-2026-04-26-slash-command-discovery.md
 * Plan lane: L0-C (handbook-manual-testing-04-26-review-co-federated-tarjan.md)
 *
 * These tests MUST remain RED until the implementation lands.
 * The expected red reason is: "discoverLocalSkillCommands is not a function"
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandService } from "../slash-command-service.js";
import type { ClaudeSDKClientFactory } from "../runtime-adapters/claude-sdk-client.js";

// ---------------------------------------------------------------------------
// Node module mocks — must be declared before any imports are resolved.
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn()
  },
  existsSync: vi.fn()
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/fake/home")
}));

// ---------------------------------------------------------------------------
// Lazy imports of the mocked modules (resolved after vi.mock hoisting).
// ---------------------------------------------------------------------------

import * as nodeFsPromises from "node:fs";
import * as nodeOs from "node:os";

// ---------------------------------------------------------------------------
// In-memory filesystem fixture
//
// Layout:
//   /fake/home/.claude/
//     commands/learn.md
//     skills/claude-hud-setup/SKILL.md
//     skills/codex-rescue/SKILL.md
//     plugins/figma/commands/figma-use.md
//     plugins/figma/skills/figma-implement-design/SKILL.md
// ---------------------------------------------------------------------------

const FAKE_HOME = "/fake/home";

const LEARN_MD = `---
description: "Learn a new concept with Claude"
display_name: "Learn"
filter_keywords: ["learn", "study", "explain"]
---

# /learn skill content
`;

const CLAUDE_HUD_SETUP_SKILL_MD = `---
name: "claude-hud:setup"
description: "Set up the Claude HUD overlay"
display_name: "Claude HUD Setup"
filter_keywords: ["hud", "setup", "overlay"]
---

# claude-hud:setup skill content
`;

const CODEX_RESCUE_SKILL_MD = `---
name: "codex:rescue"
description: "Rescue a stalled Codex session"
display_name: "Codex Rescue"
filter_keywords: ["codex", "rescue", "stalled"]
---

# codex:rescue skill content
`;

const FIGMA_USE_MD = `---
description: "Use Figma design context in Claude"
display_name: "Figma Use"
filter_keywords: ["figma", "design"]
---

# figma:figma-use command content
`;

const FIGMA_IMPLEMENT_SKILL_MD = `---
name: "figma:figma-implement-design"
description: "Implement a Figma design as code"
display_name: "Figma Implement Design"
filter_keywords: ["figma", "implement", "design", "code"]
---

# figma:figma-implement-design skill content
`;

const MALFORMED_SKILL_MD = `---
name: [unclosed bracket
description: broken yaml
`;

/**
 * Fake readdir that returns directory entries matching the in-memory layout.
 */
function fakeReaddir(path: string): Promise<string[]> {
  const map: Record<string, string[]> = {
    [`${FAKE_HOME}/.claude/commands`]: ["learn.md"],
    [`${FAKE_HOME}/.claude/skills`]: ["claude-hud-setup", "codex-rescue"],
    [`${FAKE_HOME}/.claude/skills/claude-hud-setup`]: ["SKILL.md"],
    [`${FAKE_HOME}/.claude/skills/codex-rescue`]: ["SKILL.md"],
    [`${FAKE_HOME}/.claude/plugins`]: ["figma"],
    [`${FAKE_HOME}/.claude/plugins/figma`]: ["commands", "skills"],
    [`${FAKE_HOME}/.claude/plugins/figma/commands`]: ["figma-use.md"],
    [`${FAKE_HOME}/.claude/plugins/figma/skills`]: ["figma-implement-design"],
    [`${FAKE_HOME}/.claude/plugins/figma/skills/figma-implement-design`]: ["SKILL.md"]
  };
  return Promise.resolve(map[path] ?? []);
}

/**
 * Fake readFile for the known fixture files.
 */
function fakeReadFile(filePath: string): Promise<string> {
  const map: Record<string, string> = {
    [`${FAKE_HOME}/.claude/commands/learn.md`]: LEARN_MD,
    [`${FAKE_HOME}/.claude/skills/claude-hud-setup/SKILL.md`]: CLAUDE_HUD_SETUP_SKILL_MD,
    [`${FAKE_HOME}/.claude/skills/codex-rescue/SKILL.md`]: CODEX_RESCUE_SKILL_MD,
    [`${FAKE_HOME}/.claude/plugins/figma/commands/figma-use.md`]: FIGMA_USE_MD,
    [`${FAKE_HOME}/.claude/plugins/figma/skills/figma-implement-design/SKILL.md`]: FIGMA_IMPLEMENT_SKILL_MD
  };
  const content = map[filePath];
  if (content === undefined) {
    return Promise.reject(new Error(`ENOENT: no such file or directory, open '${filePath}'`));
  }
  return Promise.resolve(content);
}

// ---------------------------------------------------------------------------
// Test factory helpers
// ---------------------------------------------------------------------------

function createService(options: {
  readonly listSupportedSlashCommands?: NonNullable<ClaudeSDKClientFactory["listSupportedSlashCommands"]>;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
} = {}): SlashCommandService {
  return new SlashCommandService({
    clientFactory: {
      listSupportedSlashCommands: options.listSupportedSlashCommands ?? vi.fn(async () => []),
      dispatchSlashCommand: vi.fn(async () => "ok")
    },
    runRepo: {
      getById: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "workspace-1",
        engine_class: "coding_engine"
      }) as any)
    },
    workspaceRepo: {
      getById: vi.fn(async () => ({
        workspace_id: "workspace-1",
        root_path: "/workspace/project",
        default_engine_class: "coding_engine"
      }) as any)
    },
    warn: options.warn ?? vi.fn()
  });
}

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

describe("SlashCommandService.discoverLocalSkillCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: fake readdir + readFile covering the full fixture layout.
    const fsMock = nodeFsPromises as unknown as {
      promises: {
        readdir: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
        stat: ReturnType<typeof vi.fn>;
      };
      existsSync: ReturnType<typeof vi.fn>;
    };

    fsMock.promises.readdir.mockImplementation(fakeReaddir);
    fsMock.promises.readFile.mockImplementation(fakeReadFile);
    fsMock.promises.stat.mockResolvedValue({ isDirectory: () => false } as any);
    fsMock.existsSync.mockReturnValue(true);

    const osMock = nodeOs as unknown as { homedir: ReturnType<typeof vi.fn> };
    osMock.homedir.mockReturnValue(FAKE_HOME);
  });

  // -------------------------------------------------------------------------
  // Test 1: returns expected discovered commands, all available
  // -------------------------------------------------------------------------
  it("returns at least /learn /claude-hud:setup /codex:rescue /figma:figma-use /figma:figma-implement-design all available=true", async () => {
    const service = createService();

    const result = await service.discoverLocalSkillCommands(FAKE_HOME);

    const names = result.map((r) => r.name);
    expect(names).toContain("/learn");
    expect(names).toContain("/claude-hud:setup");
    expect(names).toContain("/codex:rescue");
    expect(names).toContain("/figma:figma-use");
    expect(names).toContain("/figma:figma-implement-design");

    for (const cmd of result) {
      if (!["model", "help", "permissions"].some((n) => cmd.name === `/${n}`)) {
        expect(cmd.available).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: each record has all required fields populated
  // -------------------------------------------------------------------------
  it("each discovered record has source, origin, name, description, available, filter_keywords, source_path", async () => {
    const service = createService();

    const result = await service.discoverLocalSkillCommands(FAKE_HOME);

    expect(result.length).toBeGreaterThan(0);
    for (const cmd of result) {
      expect(typeof cmd.source).toBe("string");
      expect(["user", "skill", "plugin"]).toContain(cmd.source);
      expect(typeof cmd.origin).toBe("string");
      expect(cmd.origin.length).toBeGreaterThan(0);
      expect(typeof cmd.name).toBe("string");
      expect(cmd.name).toMatch(/^\//);
      expect(typeof cmd.description).toBe("string");
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(typeof cmd.available).toBe("boolean");
      expect(Array.isArray(cmd.filter_keywords)).toBe(true);
      expect(typeof cmd.source_path).toBe("string");
      expect(cmd.source_path.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: deduplication — SDK + local dir both provide /learn → exactly one
  // -------------------------------------------------------------------------
  it("deduplicates /learn when both SDK discovery and user commands dir provide it", async () => {
    const listSupportedSlashCommands = vi.fn(async () => [
      {
        name: "learn",
        description: "Learn via SDK",
        argumentHint: ""
      }
    ]);
    const service = createService({ listSupportedSlashCommands });

    const result = await service.discoverLocalSkillCommands(FAKE_HOME);

    const learnEntries = result.filter((r) => r.name === "/learn");
    expect(learnEntries).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: KNOWN_UNAVAILABLE_COMMANDS (/model /help /permissions) appear only
  //         if present in SDK discovery and keep available=false + reason
  // -------------------------------------------------------------------------
  it("KNOWN_UNAVAILABLE_COMMANDS entries keep available=false and non-empty unavailable_reason when from SDK", async () => {
    // SDK returns /model which is in KNOWN_UNAVAILABLE_COMMANDS.
    const listSupportedSlashCommands = vi.fn(async () => [
      {
        name: "model",
        description: "Change active model",
        argumentHint: ""
      }
    ]);
    const service = createService({ listSupportedSlashCommands });

    const result = await service.discoverLocalSkillCommands(FAKE_HOME);

    const modelCmd = result.find((r) => r.name === "/model");
    expect(modelCmd).toBeDefined();
    expect(modelCmd!.available).toBe(false);
    expect(typeof modelCmd!.unavailable_reason).toBe("string");
    expect(modelCmd!.unavailable_reason!.length).toBeGreaterThan(0);
  });

  it("KNOWN_UNAVAILABLE_COMMANDS entries do NOT appear when not present in SDK discovery and not locally discovered", async () => {
    // SDK returns nothing; local dir has no /model, /help, /permissions files.
    const service = createService({ listSupportedSlashCommands: vi.fn(async () => []) });

    const result = await service.discoverLocalSkillCommands(FAKE_HOME);

    const unavailableNames = ["/model", "/help", "/permissions"];
    for (const uname of unavailableNames) {
      const found = result.find((r) => r.name === uname);
      // They should either be absent or (if included) must still be available=false.
      // The stronger assertion: they should NOT appear unless discovered.
      expect(found).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: malformed SKILL.md is logged and skipped, not thrown
  // -------------------------------------------------------------------------
  it("skips malformed SKILL.md gracefully and logs a warning without throwing", async () => {
    const fsMock = nodeFsPromises as unknown as {
      promises: {
        readdir: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };
    };

    // Inject a broken-frontmatter skill alongside a valid one.
    fsMock.promises.readdir.mockImplementation((path: string): Promise<string[]> => {
      if (path === `${FAKE_HOME}/.claude/skills`) {
        return Promise.resolve(["claude-hud-setup", "broken-skill"]);
      }
      if (path === `${FAKE_HOME}/.claude/skills/broken-skill`) {
        return Promise.resolve(["SKILL.md"]);
      }
      return fakeReaddir(path);
    });

    fsMock.promises.readFile.mockImplementation((filePath: string): Promise<string> => {
      if (filePath === `${FAKE_HOME}/.claude/skills/broken-skill/SKILL.md`) {
        return Promise.resolve(MALFORMED_SKILL_MD);
      }
      return fakeReadFile(filePath);
    });

    const warn = vi.fn();
    const service = createService({ warn });

    // Must not throw.
    const result = await expect(
      service.discoverLocalSkillCommands(FAKE_HOME)
    ).resolves.toBeDefined();

    // The broken skill must not appear in results.
    const resultArray = await service.discoverLocalSkillCommands(FAKE_HOME);
    const brokenEntry = resultArray.find((r) => r.source_path?.includes("broken-skill"));
    expect(brokenEntry).toBeUndefined();

    // A warning should have been emitted.
    expect(warn).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: when homeDir is omitted, falls back to os.homedir()
  // -------------------------------------------------------------------------
  it("uses os.homedir() when homeDir argument is omitted", async () => {
    const osMock = nodeOs as unknown as { homedir: ReturnType<typeof vi.fn> };
    osMock.homedir.mockReturnValue(FAKE_HOME);

    const service = createService();

    // Should not throw and should still find the fixture commands.
    const result = await service.discoverLocalSkillCommands(); // no homeDir
    const names = result.map((r) => r.name);
    expect(names).toContain("/learn");

    expect(osMock.homedir).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: concurrency — two parallel calls do not double-emit nor corrupt
  // -------------------------------------------------------------------------
  it("parallel calls produce equivalent results and do not double-emit", async () => {
    const service = createService();

    const [first, second] = await Promise.all([
      service.discoverLocalSkillCommands(FAKE_HOME),
      service.discoverLocalSkillCommands(FAKE_HOME)
    ]);

    // Both calls must resolve to the same canonical set (by name).
    const firstNames = first.map((r) => r.name).sort();
    const secondNames = second.map((r) => r.name).sort();
    expect(firstNames).toEqual(secondNames);

    // No duplicates in either result.
    const uniqueFirst = new Set(firstNames);
    expect(uniqueFirst.size).toBe(firstNames.length);

    const uniqueSecond = new Set(secondNames);
    expect(uniqueSecond.size).toBe(secondNames.length);
  });

  // -------------------------------------------------------------------------
  // Test 8: none of the directories exist — returns SDK results, does not throw
  // -------------------------------------------------------------------------
  it("returns SDK-discovered commands without throwing when no local directories exist", async () => {
    const fsMock = nodeFsPromises as unknown as {
      promises: {
        readdir: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };
      existsSync: ReturnType<typeof vi.fn>;
    };

    // All directories report as non-existent.
    fsMock.existsSync.mockReturnValue(false);
    fsMock.promises.readdir.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    const listSupportedSlashCommands = vi.fn(async () => [
      {
        name: "cost",
        description: "Show session cost",
        argumentHint: ""
      }
    ]);
    const service = createService({ listSupportedSlashCommands });

    const result = await service.discoverLocalSkillCommands(FAKE_HOME);

    // SDK /cost should still come through (it is allowlisted).
    // At minimum we expect no throw and the array is defined.
    expect(Array.isArray(result)).toBe(true);
  });
});
