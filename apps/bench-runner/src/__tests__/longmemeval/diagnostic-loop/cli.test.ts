import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../cli/index.js";
import { runDiagnosticLoopCommand } from "../../../cli/diagnostic-loop/command.js";
import { parseDiagnosticLoopArgs } from "../../../cli/diagnostic-loop/args.js";
import { digest, loopRequest, trackingAdapters } from "./fixture.js";
import { checkpointDigest } from "../../../bench/diagnostic-loop/checkpoint.js";
import { readExtractionCacheManifestIdentity } from
  "../../../bench/extraction/cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from
  "../../../bench/extraction/content-closure.js";

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

  it("remaps a display model alias and refuses a mismatched profile", async () => {
    const parsed = parseDiagnosticLoopArgs([
      ...requiredFlags({ extra: ["--model", "Mimo-V2.5"] })
    ]);
    expect(parsed.request.model).toBe("mimo-v2.5");
    expect(parsed.request.requestProfile).toBe("mimo-v2.5-nonthinking-v1");
    expect(() => parseDiagnosticLoopArgs([
      ...requiredFlags({ extra: ["--request-profile", "provider-default-v1"] })
    ])).toThrow(/requires request profile mimo-v2.5-nonthinking-v1/u);
  });

  it("rejects a bare diagnostic-loop command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCli(["diagnostic-loop"])).toBe(2);
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toMatch(
      /missing required diagnostic-loop flags|requires --request-manifest/u
    );
  });

  it("rejects the legacy scalar identity route at the production CLI", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runCli(["diagnostic-loop", ...requiredFlags({})])).toBe(2);
    expect(stderr.mock.calls.map((call) => String(call[0])).join(""))
      .toContain("diagnostic-loop requires --request-manifest");
  });

  it("validates and reruns a failed v2 checkpoint", async () => {
    const workRoot = await tempRoot();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runDiagnosticLoopCommand(
      requiredFlags({ workRoot }), { adapters: trackingAdapters().adapters }
    )).toBe(0);
    const path = join(workRoot, "checkpoints", "control_recall.json");
    const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { checkpoint_digest: _digest, ...body } = { ...current, status: "failed" };
    await writeFile(path, `${JSON.stringify({
      ...body,
      checkpoint_digest: checkpointDigest(body as never)
    }, null, 2)}\n`);

    const resumed = trackingAdapters();
    expect(await runDiagnosticLoopCommand(
      requiredFlags({ workRoot }), { adapters: resumed.adapters }
    )).toBe(0);
    expect(resumed.calls).toEqual(["control_recall", "treatment_recall", "miss_ledger"]);
  });

  it("reads the shared sealed request manifest instead of a giant key argv", async () => {
    const root = await tempRoot();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const workRoot = join(root, "source-run");
    expect(await runDiagnosticLoopCommand(
      requiredFlags({ workRoot }), { adapters: trackingAdapters().adapters }
    )).toBe(0);
    const cacheRoot = join(workRoot, "tracking-extraction-cache");
    const cache = readExtractionCacheManifestIdentity(cacheRoot)!;
    const request = loopRequest({
      extractionCacheRoot: cacheRoot,
      providerRoute: cache.manifest.provider_url,
      limit: 1,
      offset: 0
    });
    const manifestPath = join(root, "request-manifest.json");
    const body = {
      schema_version: 1,
      kind: "provider_preflight_replay_request",
      request,
      canonical_keys: {
        count: request.requestedKeys.length,
        key_set_sha256: computeExtractionKeySetSha256(request.requestedKeys)
      },
      cache_authority: {
        manifest_sha256: cache.manifestSha256,
        content_closure_sha256: cache.manifest.content_closure_sha256,
        expected_key_set_sha256: cache.manifest.expected_key_set_sha256,
        shard_count: cache.manifest.expected_turns,
        window_offset: cache.manifest.window_offset,
        window_limit: cache.manifest.window_limit
      },
      dataset_authority: {}
    };
    await writeFile(manifestPath, `${JSON.stringify({
      ...body,
      request_manifest_sha256: createHash("sha256")
        .update(JSON.stringify(body), "utf8").digest("hex")
    })}\n`);

    const parsed = parseDiagnosticLoopArgs([
      "--work-root", join(root, "target"), "--request-manifest", manifestPath
    ]);
    expect(parsed.request.requestedKeys).toEqual(request.requestedKeys);
    expect(parsed.request.extractionCacheRoot).toBe(cacheRoot);
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
    "--model", "mimo-v2.5",
    "--request-profile", "mimo-v2.5-nonthinking-v1",
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
