import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXEC_SHELL_TOOL_SPEC, execShell, normalizeTimeout } from "../tools/exec-shell-tool.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
});

describe("execShell", () => {
  it("exports a confirmation-required exec tool spec", () => {
    expect(EXEC_SHELL_TOOL_SPEC).toMatchObject({
      tool_id: "tools.exec_shell",
      category: "exec",
      read_only: false,
      destructive: true,
      requires_confirmation: true,
      fast_path_eligible: false
    });
  });

  it("captures stdout from a successful command and locks cwd to writableRoots[0]", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      execShell(
        {
          command: "/bin/sh",
          args: ["-c", "pwd"]
        },
        [workspaceDir]
      )
    ).resolves.toEqual({
      ok: true,
      exitCode: 0,
      stdout: `${workspaceDir}\n`,
      stderr: ""
    });
  });

  it("returns non-zero exit codes as ok:true so the model can inspect output", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      execShell(
        {
          command: "/bin/sh",
          args: ["-c", "exit 42"]
        },
        [workspaceDir]
      )
    ).resolves.toEqual({
      ok: true,
      exitCode: 42,
      stdout: "",
      stderr: ""
    });
  });

  it("captures stderr output", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      execShell(
        {
          command: "/bin/sh",
          args: ["-c", "printf 'err\\n' >&2"]
        },
        [workspaceDir]
      )
    ).resolves.toEqual({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "err\n"
    });
  });

  it("passes only the minimal child-process environment needed for execution", async () => {
    const workspaceDir = await createWorkspace();
    const originalSecret = process.env.DO_WHAT_TEST_SECRET_TOKEN;
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.DO_WHAT_TEST_SECRET_TOKEN = "super-secret";
    process.env.NODE_ENV = "test";

    try {
      await expect(
        execShell(
          {
            command: "/bin/sh",
            args: [
              "-c",
              'printf "%s|%s|%s" "${DO_WHAT_TEST_SECRET_TOKEN:-}" "${NODE_ENV:-}" "${PATH:+present}"'
            ]
          },
          [workspaceDir]
        )
      ).resolves.toEqual({
        ok: true,
        exitCode: 0,
        stdout: "|test|present",
        stderr: ""
      });
    } finally {
      if (originalSecret === undefined) {
        delete process.env.DO_WHAT_TEST_SECRET_TOKEN;
      } else {
        process.env.DO_WHAT_TEST_SECRET_TOKEN = originalSecret;
      }

      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("truncates oversized user-visible output", async () => {
    const workspaceDir = await createWorkspace();
    const outputLength = 131_072 + 32;

    const result = await execShell(
      {
        command: "/bin/sh",
        args: ["-c", `yes x | head -c ${outputLength}`]
      },
      [workspaceDir]
    );

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stderr: ""
    });
    if (!result.ok) {
      throw new Error("expected success result");
    }
    expect(result.stdout).toHaveLength(131_072 + "\n[truncated]".length);
    expect(result.stdout.endsWith("\n[truncated]")).toBe(true);
  });

  it("truncates output by utf-8 byte length, not code-unit length", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "unicode-output.txt");
    await fsWriteFile(filePath, "你".repeat(70_000), "utf8");

    const result = await execShell(
      {
        command: "/bin/sh",
        args: ["-c", `cat "${filePath}"`]
      },
      [workspaceDir]
    );

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stderr: ""
    });
    if (!result.ok) {
      throw new Error("expected success result");
    }
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      131_072 + Buffer.byteLength("\n[truncated]", "utf8")
    );
    expect(result.stdout.endsWith("\n[truncated]")).toBe(true);
  });

  it("returns EXEC_ERROR when the command cannot be spawned", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      execShell(
        {
          command: "dw-missing-command"
        },
        [workspaceDir]
      )
    ).resolves.toMatchObject({
      ok: false,
      code: "EXEC_ERROR"
    });
  });

  it("returns TIMEOUT when the command exceeds timeoutMs", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      execShell(
        {
          command: "/bin/sh",
          args: ["-c", "sleep 10"],
          timeoutMs: 100
        },
        [workspaceDir]
      )
    ).resolves.toMatchObject({
      ok: false,
      code: "TIMEOUT"
    });
  });

  it.each([undefined, 0, -1])(
    "uses the default timeout when timeoutMs is %s",
    async (timeoutMs) => {
      const workspaceDir = await createWorkspace();

      await expect(
        execShell(
          {
            command: "/bin/sh",
            args: ["-c", "printf ok"],
            timeoutMs
          },
          [workspaceDir]
        )
      ).resolves.toEqual({
        ok: true,
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      });
    }
  );

  it("clamps timeoutMs to the hard maximum", () => {
    expect(normalizeTimeout(999_999)).toBe(120_000);
  });

  it("returns ACCESS_DENIED when writableRoots is empty", async () => {
    await expect(
      execShell(
        {
          command: "/bin/sh",
          args: ["-c", "printf ok"]
        },
        []
      )
    ).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
  });
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dw-a2-7-exec-"));
  tempDirs.add(dir);
  return dir;
}
