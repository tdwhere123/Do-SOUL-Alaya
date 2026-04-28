import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFileTree,
  buildKeyFileSummaries,
  buildWorkspaceContext
} from "../system-prompt/workspace-context.js";
import { buildSystemPrompt } from "../system-prompt/template.js";
import type { Run, Workspace } from "@do-what/protocol";
import { WorkspaceKind, WorkspaceState, RunMode, RunState } from "@do-what/protocol";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "do-what-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relativePath: string, content = "content"): string {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

function mkdir(relativePath: string): void {
  fs.mkdirSync(path.join(tmpDir, relativePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// buildFileTree — basic output
// ---------------------------------------------------------------------------

describe("buildFileTree", () => {
  it("returns non-empty string for a directory with files", async () => {
    writeFile("src/index.ts");
    writeFile("README.md");

    const tree = await buildFileTree(tmpDir);
    expect(tree.length).toBeGreaterThan(0);
    expect(tree).toContain("README.md");
    expect(tree).toContain("src");
  });

  it("returns empty string for nonexistent path", async () => {
    const tree = await buildFileTree("/nonexistent/path/that/does/not/exist");
    expect(tree).toBe("");
  });

  it("returns empty string for empty string path", async () => {
    const tree = await buildFileTree("");
    expect(tree).toBe("");
  });

  it("handles empty directory without throwing", async () => {
    const tree = await buildFileTree(tmpDir);
    expect(tree).toBeDefined();
  });

  // Depth limit
  // "max 3 layers" = traverse directories up to 3 levels deep from root.
  // Files whose parent directory is at depth <= 3 are included.
  // Directories at depth 4 and their contents are excluded.
  it("does not include files inside a directory 4 levels deep", async () => {
    writeFile("a/b/c/d/deep.ts"); // a(1)/b(2)/c(3)/d(4) — dir at depth 4 → excluded
    writeFile("a/b/shallow.ts"); // a(1)/b(2) → included

    const tree = await buildFileTree(tmpDir);
    expect(tree).toContain("shallow.ts");
    expect(tree).not.toContain("deep.ts");
  });

  it("includes files at exactly depth 3 (file in dir 3 levels deep)", async () => {
    writeFile("level1/level2/level3/file.ts"); // level3 is at depth 3 → file.ts included

    const tree = await buildFileTree(tmpDir);
    expect(tree).toContain("file.ts");
  });

  // Exclusions — directories
  it("excludes node_modules directory", async () => {
    mkdir("node_modules");
    writeFile("node_modules/lodash/index.js");
    writeFile("src/app.ts");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("node_modules");
    expect(tree).toContain("src");
  });

  it("excludes .git directory", async () => {
    mkdir(".git");
    writeFile(".git/config");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain(".git");
  });

  it("excludes dist directory", async () => {
    mkdir("dist");
    writeFile("dist/bundle.js");
    writeFile("src/index.ts");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("dist");
    expect(tree).toContain("src");
  });

  it("excludes build directory", async () => {
    mkdir("build");
    writeFile("build/output.js");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("build");
  });

  it("excludes .next directory", async () => {
    mkdir(".next");
    writeFile(".next/server/app.js");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain(".next");
  });

  it("excludes __pycache__ directory", async () => {
    mkdir("__pycache__");
    writeFile("__pycache__/module.pyc");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("__pycache__");
  });

  it("excludes .venv directory", async () => {
    mkdir(".venv");
    writeFile(".venv/bin/python");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain(".venv");
  });

  // Exclusions — lock files (specific and wildcard)
  it("excludes .DS_Store files", async () => {
    writeFile(".DS_Store");
    writeFile("README.md");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain(".DS_Store");
  });

  it("excludes pnpm-lock.yaml", async () => {
    writeFile("pnpm-lock.yaml");
    writeFile("package.json", "{}");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("pnpm-lock.yaml");
    expect(tree).toContain("package.json");
  });

  it("excludes package-lock.json", async () => {
    writeFile("package-lock.json");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("package-lock.json");
  });

  it("excludes yarn.lock", async () => {
    writeFile("yarn.lock");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("yarn.lock");
  });

  it("excludes Cargo.lock (Rust)", async () => {
    writeFile("Cargo.lock");
    writeFile("Cargo.toml");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("Cargo.lock");
    expect(tree).toContain("Cargo.toml");
  });

  it("excludes Gemfile.lock (Ruby)", async () => {
    writeFile("Gemfile.lock");
    writeFile("Gemfile");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("Gemfile.lock");
    expect(tree).toContain("Gemfile");
  });

  it("excludes uv.lock (Python uv)", async () => {
    writeFile("uv.lock");
    writeFile("pyproject.toml");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("uv.lock");
    expect(tree).toContain("pyproject.toml");
  });

  it("excludes poetry.lock (Python Poetry)", async () => {
    writeFile("poetry.lock");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("poetry.lock");
  });

  // Line limit
  it("truncates output at 100 lines and appends truncation marker", async () => {
    // Create 110 files in a flat directory
    for (let i = 0; i < 110; i++) {
      writeFile(`file${String(i).padStart(3, "0")}.ts`);
    }

    const tree = await buildFileTree(tmpDir);
    const lines = tree.split("\n").filter((l) => l.length > 0);

    expect(lines.length).toBeLessThanOrEqual(101); // 100 content lines + truncation marker
    expect(tree).toContain("truncated");
  });

  it("does not add truncation marker when lines < 100", async () => {
    writeFile("a.ts");
    writeFile("b.ts");

    const tree = await buildFileTree(tmpDir);
    expect(tree).not.toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// buildKeyFileSummaries
// ---------------------------------------------------------------------------

describe("buildKeyFileSummaries", () => {
  it("includes README.md content when present", async () => {
    writeFile("README.md", "# My Project\nThis is a great project.");

    const summaries = await buildKeyFileSummaries(tmpDir);
    expect(summaries).toContain("README.md");
    expect(summaries).toContain("My Project");
  });

  it("includes package.json content when present", async () => {
    writeFile("package.json", '{"name": "my-app", "version": "1.0.0"}');

    const summaries = await buildKeyFileSummaries(tmpDir);
    expect(summaries).toContain("package.json");
    expect(summaries).toContain("my-app");
  });

  it("includes CLAUDE.md content when present", async () => {
    writeFile("CLAUDE.md", "# CLAUDE\nRead this file.");

    const summaries = await buildKeyFileSummaries(tmpDir);
    expect(summaries).toContain("CLAUDE.md");
    expect(summaries).toContain("Read this file");
  });

  it("silently skips missing files — no error thrown", async () => {
    // No files written — all three are missing
    await expect(buildKeyFileSummaries(tmpDir)).resolves.toBeDefined();
  });

  it("returns non-empty string even when only one file exists", async () => {
    writeFile("README.md", "Hello");

    const summaries = await buildKeyFileSummaries(tmpDir);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries).toContain("README.md");
  });

  it("returns content in full when file is shorter than 500 chars — no truncation marker", async () => {
    const shortContent = "Short content.";
    writeFile("README.md", shortContent);

    const summaries = await buildKeyFileSummaries(tmpDir);
    expect(summaries).toContain(shortContent);
    expect(summaries).not.toContain("truncated");
  });

  it("truncates content to 500 chars when file exceeds limit", async () => {
    const longContent = "A".repeat(600);
    writeFile("README.md", longContent);

    const summaries = await buildKeyFileSummaries(tmpDir);
    expect(summaries).toContain("truncated");
    // The actual README content in the summary should not contain 600 A's
    expect(summaries.split("README.md")[1]?.includes("A".repeat(600))).toBe(false);
  });

  it("skips symlinked key files to prevent reading arbitrary host files", async () => {
    // Create a real file outside the workspace to simulate host file injection
    const secretContent = "SECRET_HOST_DATA_SHOULD_NOT_APPEAR";
    const realFile = path.join(tmpDir, "_outside", "secret.txt");
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, secretContent, "utf8");

    // Symlink README.md to the outside file
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.symlinkSync(realFile, path.join(workspaceDir, "README.md"));

    // Also write a real CLAUDE.md to verify normal files still work
    fs.writeFileSync(path.join(workspaceDir, "CLAUDE.md"), "Real content", "utf8");

    const summaries = await buildKeyFileSummaries(workspaceDir);

    // Symlinked README.md must NOT be read
    expect(summaries).not.toContain(secretContent);
    // Real CLAUDE.md must still be included
    expect(summaries).toContain("CLAUDE.md");
    expect(summaries).toContain("Real content");
  });
});

// ---------------------------------------------------------------------------
// buildWorkspaceContext
// ---------------------------------------------------------------------------

describe("buildWorkspaceContext", () => {
  it("returns string containing ## Workspace Context header", async () => {
    writeFile("src/index.ts");

    const context = await buildWorkspaceContext(tmpDir);
    expect(context).toContain("## Workspace Context");
  });

  it("contains ### File Tree section", async () => {
    writeFile("src/index.ts");

    const context = await buildWorkspaceContext(tmpDir);
    expect(context).toContain("### File Tree");
  });

  it("contains ### Key Files section", async () => {
    writeFile("README.md", "Hello");

    const context = await buildWorkspaceContext(tmpDir);
    expect(context).toContain("### Key Files");
  });

  it("total output is less than 4000 characters", async () => {
    writeFile("README.md", "R".repeat(1000));
    writeFile("package.json", "P".repeat(1000));
    writeFile("CLAUDE.md", "C".repeat(1000));
    for (let i = 0; i < 80; i++) {
      writeFile(`src/file${i}.ts`);
    }

    const context = await buildWorkspaceContext(tmpDir);
    expect(context.length).toBeLessThanOrEqual(4000);
  });

  it("returns empty string for empty root path", async () => {
    const context = await buildWorkspaceContext("");
    expect(context).toBe("");
  });

  it("returns empty string for nonexistent root path", async () => {
    const context = await buildWorkspaceContext("/path/does/not/exist");
    expect(context).toBe("");
  });

  it("returns empty string for relative root path (path traversal guard)", async () => {
    const context = await buildWorkspaceContext("../../etc");
    expect(context).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Performance test — file tree generation < 200ms for ~500 files
// ---------------------------------------------------------------------------

describe("buildFileTree — performance", () => {
  it("completes in under 200ms for a directory with ~500 files", async () => {
    // Create 500 files across a shallow tree (3 dirs × ~167 files each)
    for (let d = 0; d < 3; d++) {
      for (let f = 0; f < 167; f++) {
        writeFile(`dir${d}/file${String(f).padStart(3, "0")}.ts`);
      }
    }

    const start = Date.now();
    await buildFileTree(tmpDir);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it("completes in under 10ms for an empty directory", async () => {
    const start = Date.now();
    await buildFileTree(tmpDir);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt integration
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — workspace context integration", () => {
  function makeWorkspace(rootPath: string): Workspace {
    return {
      workspace_id: "ws-test",
      name: "Test Workspace",
      root_path: rootPath,
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      repo_path: null,
      workspace_state: WorkspaceState.ACTIVE,
      default_engine_binding: null,
      created_at: "2026-01-01T00:00:00.000Z",
      archived_at: null
    };
  }

  function makeRun(): Run {
    return {
      run_id: "run-test",
      workspace_id: "ws-test",
      title: "test run",
      run_mode: RunMode.CHAT,
      goal: "Test the system",
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      last_active_at: "2026-01-01T00:00:00.000Z"
    };
  }

  it("includes ## Workspace Context when root_path is valid", async () => {
    writeFile("README.md", "# Test project");

    const prompt = await buildSystemPrompt(makeWorkspace(tmpDir), makeRun());
    expect(prompt).toContain("## Workspace Context");
  });

  it("does not include ## Workspace Context when root_path is empty", async () => {
    const prompt = await buildSystemPrompt(makeWorkspace(""), makeRun());
    expect(prompt).not.toContain("## Workspace Context");
  });
});
