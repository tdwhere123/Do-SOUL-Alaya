import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../cli/index.js";
import { runDiagnosticLoopCommand } from "../../../cli/diagnostic-loop/command.js";
import { parseDiagnosticLoopArgs } from "../../../cli/diagnostic-loop/args.js";
import { digest, trackingAdapters } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop CLI", () => {
  it("documents the resumable command on --help", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runCli(["--help"])).toBe(0);
    const text = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("diagnostic-loop --work-root <dir>");
    expect(text).toContain("--mode smoke|run|cache-only|report-only");
    expect(text).toContain("--from-phase");
  });

  it("parses identity flags and defaults smoke onto the worker path", () => {
    const parsed = parseDiagnosticLoopArgs(requiredFlags({
      extra: ["--mode", "smoke", "--limit", "1"]
    }));
    expect(parsed.mode).toBe("smoke");
    expect(parsed.request.worker).toBe(true);
    expect(parsed.request.cacheMode).toBe("cache_only");
    expect(parsed.request.variant).toBe("longmemeval_s");
    expect(parsed.request.limit).toBe(1);
  });

  it("dispatches through injected adapters and prints avoided work", async () => {
    const workRoot = await tempRoot();
    const tracked = trackingAdapters();
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const exit = await runDiagnosticLoopCommand(
      requiredFlags({ workRoot, extra: ["--mode", "cache-only", "--limit", "1"] }),
      { adapters: tracked.adapters }
    );

    expect(exit).toBe(0);
    expect(tracked.calls).toContain("extraction");
    const text = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("provider_calls_avoided=");
    expect(text).toContain("report=");
  });

  it("prints a resume command when a phase fails", async () => {
    const workRoot = await tempRoot();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const tracked = trackingAdapters();
    const adapters = {
      ...tracked.adapters,
      authority_cache: async () => {
        throw new Error("cache identity mismatch: model");
      }
    };

    const exit = await runDiagnosticLoopCommand(
      requiredFlags({ workRoot }),
      { adapters }
    );

    expect(exit).toBe(2);
    const text = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("phase=authority_cache");
    expect(text).toContain("class=authority");
    expect(text).toContain(`--work-root ${workRoot}`);
    expect(text).toContain("--from-phase authority_cache");
  });

  it("rejects a bare diagnostic-loop command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCli(["diagnostic-loop"])).toBe(2);
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toMatch(
      /missing required diagnostic-loop flags/u
    );
  });
});

function requiredFlags(input: {
  readonly workRoot?: string;
  readonly extra?: readonly string[];
}): string[] {
  return [
    "--work-root", input.workRoot ?? "/tmp/diagnostic-loop",
    "--dataset-revision", digest("dataset"),
    "--requested-keys", digest("key-1"),
    "--provider-route", "mimo",
    "--model", "mimo-v2-flash",
    "--request-profile", "provider-default-v1",
    "--prompt-digest", digest("prompt"),
    "--schema-digest", digest("schema"),
    "--operator-digest", digest("operator"),
    ...(input.extra ?? [])
  ];
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-loop-cli-"));
  roots.push(root);
  return root;
}
