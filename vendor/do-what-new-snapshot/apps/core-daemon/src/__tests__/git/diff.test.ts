import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitDiffService, GitInputError, GitTimeoutError } from "../../git/diff.js";
import { createGitLogService } from "../../git/log.js";
import { createFixtureRepo } from "../fixtures/fixture-repo-setup.js";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("git diff service", () => {
  it("uses hardened execFile args with a minimal env for file diffs", async () => {
    const controller = new AbortController();
    const captured: {
      file?: string;
      args?: readonly string[];
      options?: Record<string, unknown>;
    } = {};
    const service = createGitDiffService({
      realpathImpl: async (value) => value,
      execFileImpl: ((file, args, options, callback) => {
        captured.file = file;
        captured.args = args;
        captured.options = options as Record<string, unknown>;
        callback(null, Buffer.from("diff --git a/src/app.ts b/src/app.ts\n"), Buffer.alloc(0));
        return {} as any;
      }) as any
    });

    const diff = await service.getFileDiff({
      repoPath: "/repo",
      path: "src/app.ts",
      signal: controller.signal
    });

    expect(captured.file).toBe("git");
    expect(captured.args).toEqual([
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "diff.textconv=",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      "HEAD",
      "--",
      "src/app.ts"
    ]);
    expect(captured.options).toMatchObject({
      cwd: "/repo",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GIT_PAGER: "cat",
        GIT_LITERAL_PATHSPECS: "1"
      },
      timeout: 5_000,
      maxBuffer: 1_048_577,
      windowsHide: true,
      signal: controller.signal,
      encoding: "buffer"
    });
    expect((captured.options as { shell?: boolean }).shell).toBeUndefined();
    expect(diff).toMatchObject({
      repoPath: "/repo",
      path: "src/app.ts",
      since: "HEAD",
      against: "working_tree",
      binary: false,
      truncated: false,
      unifiedDiff: "diff --git a/src/app.ts b/src/app.ts\n"
    });
  });

  it("passes AbortSignal to execFile and aborts before the timeout path", async () => {
    const controller = new AbortController();
    let sawAbort = false;

    const service = createGitDiffService({
      realpathImpl: async (value) => value,
      execFileImpl: ((_, __, options, callback) => {
        const signal = (options as { signal?: AbortSignal }).signal;
        const abortWithError = (): void => {
          sawAbort = true;
          callback(
            Object.assign(new Error("The operation was aborted"), {
              name: "AbortError",
              code: "ABORT_ERR"
            }) as any,
            Buffer.alloc(0),
            Buffer.alloc(0)
          );
        };

        if (signal?.aborted === true) {
          abortWithError();
          return {} as any;
        }

        signal?.addEventListener(
          "abort",
          abortWithError,
          { once: true }
        );

        return {} as any;
      }) as any
    });

    const pendingDiff = service.getFileDiff({
      repoPath: "/repo",
      path: "src/app.ts",
      signal: controller.signal
    });

    controller.abort();

    const error = await pendingDiff.catch((caught) => caught);

    expect(error).toBeInstanceOf(GitTimeoutError);
    expect(error).toHaveProperty("message", "git command timed out");
    expect(sawAbort).toBe(true);
  });

  it("marks truncated diffs with a sentinel when git output exceeds the cap", async () => {
    const service = createGitDiffService({
      realpathImpl: async (value) => value,
      execFileImpl: ((_, __, ___, callback) => {
        const error = Object.assign(new Error("maxBuffer length exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        });
        callback(error as any, Buffer.from("diff --git a/file b/file\n+line\n"), Buffer.alloc(0));
        return {} as any;
      }) as any
    });

    const diff = await service.getFileDiff({
      repoPath: "/repo",
      path: "file"
    });

    expect(diff.truncated).toBe(true);
    expect(diff.unifiedDiff).toBe("diff --git a/file b/file\n+line\n<truncated>\n");
  });

  it("uses single-ref commit diffs when against=commit:<sha>", async () => {
    const captured: {
      file?: string;
      args?: readonly string[];
    } = {};
    const service = createGitDiffService({
      realpathImpl: async (value) => value,
      execFileImpl: ((file, args, _options, callback) => {
        captured.file = file;
        captured.args = args;
        callback(null, Buffer.from("diff --git a/src/app.ts b/src/app.ts\n"), Buffer.alloc(0));
        return {} as any;
      }) as any
    });

    const diff = await service.getFileDiff({
      repoPath: "/repo",
      path: "src/app.ts",
      since: "HEAD",
      against: "commit:abc1234"
    });

    expect(captured.file).toBe("git");
    expect(captured.args).toEqual([
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "diff.textconv=",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      "abc1234",
      "--",
      "src/app.ts"
    ]);
    expect(diff.since).toBe("abc1234");
    expect(diff.against).toBe("commit:abc1234");
  });

  it("catches a symlink swap on the second realpath check before execFile", async () => {
    const fixture = await createFixtureRepo();
    tempDirectories.add(fixture.repoPath);
    const outsideDirectory = await mkdtemp(path.join(process.cwd(), ".tmp-c31-outside-"));
    tempDirectories.add(outsideDirectory);

    await fixture.write("inside/file.txt", "inside\n");
    await fixture.link("link", fixture.resolve("inside"));
    await writeFile(path.join(outsideDirectory, "file.txt"), "outside\n");

    const execSpy = vi.fn();
    let targetRealpathCalls = 0;
    const targetPath = fixture.resolve("link/file.txt");
    const service = createGitDiffService({
      execFileImpl: execSpy as any,
      realpathImpl: async (value) => {
        if (value === targetPath) {
          targetRealpathCalls += 1;

          if (targetRealpathCalls === 2) {
            await fixture.link("link", outsideDirectory);
          }
        }

        return await realpath(value);
      }
    });

    await expect(
      service.getFileDiff({
        repoPath: fixture.repoPath,
        path: "link/file.txt"
      })
    ).rejects.toBeInstanceOf(GitInputError);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("rejects git pathspec magic in requested paths", async () => {
    const service = createGitDiffService({
      realpathImpl: async (value) => value
    });

    await expect(
      service.getFileDiff({
        repoPath: "/repo",
        path: ":(glob)**"
      })
    ).rejects.toThrow("path must be a literal workspace-relative path");
  });
});

describe("git log service", () => {
  it("uses hardened execFile args and parses the git log payload", async () => {
    const controller = new AbortController();
    const captured: {
      file?: string;
      args?: readonly string[];
      options?: Record<string, unknown>;
    } = {};
    const service = createGitLogService({
      realpathImpl: async (value) => value,
      execFileImpl: ((file, args, options, callback) => {
        captured.file = file;
        captured.args = args;
        captured.options = options as Record<string, unknown>;
        callback(
          null,
          Buffer.from(
            [
              "abcdef1234567890",
              "abcdef1",
              "Alice",
              "alice@example.test",
              "2026-04-23T00:00:00.000Z",
              "commit subject",
              ""
            ].join("\0")
          ),
          Buffer.alloc(0)
        );
        return {} as any;
      }) as any
    });

    const gitLog = await service.listGitLog({
      repoPath: "/repo",
      limit: 100,
      path: "src/app.ts",
      signal: controller.signal
    });

    expect(captured.file).toBe("git");
    expect(captured.args).toEqual([
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "diff.textconv=",
      "log",
      "--no-color",
      "--format=format:%H%x00%h%x00%an%x00%ae%x00%cI%x00%s%x00",
      "-100",
      "--",
      "src/app.ts"
    ]);
    expect(captured.args?.some((arg) => arg.startsWith("--pretty=format:"))).toBe(false);
    expect(captured.options).toMatchObject({
      cwd: "/repo",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GIT_PAGER: "cat",
        GIT_LITERAL_PATHSPECS: "1"
      },
      timeout: 5_000,
      maxBuffer: 262_145,
      windowsHide: true,
      signal: controller.signal,
      encoding: "buffer"
    });
    expect(gitLog).toEqual({
      repoPath: "/repo",
      path: "src/app.ts",
      truncated: false,
      commits: [
        {
          sha: "abcdef1234567890",
          short_sha: "abcdef1",
          author_name: "Alice",
          author_email: "alice@example.test",
          committed_at: "2026-04-23T00:00:00.000Z",
          subject: "commit subject"
        }
      ]
    });
  });

  it("parses commit subjects containing the old control separators without corrupting records", async () => {
    const service = createGitLogService({
      realpathImpl: async (value) => value,
      execFileImpl: ((_, __, ___, callback) => {
        callback(
          null,
          Buffer.from(
            [
              "abcdef1234567890",
              "abcdef1",
              "Alice",
              "alice@example.test",
              "2026-04-23T00:00:00.000Z",
              "subject with \u001e and \u001f separators",
              ""
            ].join("\0")
          ),
          Buffer.alloc(0)
        );
        return {} as any;
      }) as any
    });

    await expect(
      service.listGitLog({
        repoPath: "/repo",
        limit: 1,
        path: "src/app.ts"
      })
    ).resolves.toMatchObject({
      commits: [
        {
          subject: "subject with \u001e and \u001f separators"
        }
      ]
    });
  });
});
