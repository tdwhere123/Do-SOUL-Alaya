import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseFlags } from "../../cli/cli-options.js";
import { runExtractionFillCommand } from "../../cli/extraction-fill/command-core.js";
import { runSemanticProposalFillCommand } from "../../cli/semantic-proposal-fill/command.js";
import { acquireExtractionCacheWriteLease, withExtractionCacheWriteLease } from
  "../../runs/extraction/fill/manifest/fill-root-guard.js";
import { pinSemanticProposalAuthority } from "../../runs/semantic-proposal/authority.js";
import * as proposals from "../../runs/semantic-proposal/fill.js";
import { parseSemanticProposalWorkset } from "../../runs/semantic-proposal/workset.js";

// The diagnostic seam needs real directory ownership checks, not a socket listener.
vi.mock("../../runs/extraction/fill/manifest/kernel-write-lease.js", () => ({
  acquireKernelWriteLease: () => ({ assertOwned() {}, release() {} }),
  isKernelWriteLeaseActive: () => false
}));

const roots: string[] = [];
const workset = parseSemanticProposalWorkset({
  contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
  kind: "query", model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
  items: [{ original_query: "Who chairs SHADOW?" }]
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "fill-failure-"));
  roots.push(path);
  return path;
}

function replaceOwner(cacheRoot: string): void {
  writeFileSync(join(cacheRoot, ".extraction-fill.lock", "owner.json"),
    JSON.stringify({ pid: process.pid, token: "replaced" }), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("renders the original and release errors from the filesystem lease wrapper at the extraction CLI", async () => {
  const cacheRoot = root();
  const primary = new Error("local extraction preparation failed");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  let failure: unknown;
  const exitCode = await runExtractionFillCommand(parseFlags(["--variant", "longmemeval_oracle"]), {
    signalSource: { on() {}, off() {} },
    runExtractionFill: async () => {
      const lease = acquireExtractionCacheWriteLease(cacheRoot);
      try {
        return await withExtractionCacheWriteLease(lease, async () => {
          replaceOwner(cacheRoot);
          throw primary;
        });
      } catch (error) {
        failure = error;
        throw error;
      }
    }
  });
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("expected paired failure");
  expect(failure.errors[0]).toBe(primary);
  expect(String(failure.errors[1])).toContain("ownership changed");
  const message = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
  expect(exitCode).toBe(2);
  expect(message).toMatch(/local extraction preparation failed.*ownership changed/su);
});

it.each([new Error("local transport preparation failed"), undefined])(
  "preserves the original thrown value when proposal lease cleanup also fails: %s", async (primary) => {
    const cacheRoot = root();
    const authority = pinSemanticProposalAuthority({
      preflight: proposals.prepareSemanticProposal(workset, cacheRoot, 128),
      inputUsdPerMillion: 1, outputUsdPerMillion: 2
    });
    const assertTransportReady = vi.fn(async () => {
      replaceOwner(cacheRoot);
      throw primary;
    });
    const extract = vi.fn(async () => { throw new Error("provider dispatch must not run"); });
    const failure: unknown = await proposals.executeSemanticProposalFill({
      workset, cacheRoot, authority,
      config: { providerUrl: workset.provider_url, model: workset.model,
        requestProfile: "gemini-3.1-minimal-v1", apiKey: null },
      extractor: { assertTransportReady, extract }
    }).catch((error: unknown) => error);
    expect(assertTransportReady).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("expected paired failure");
    expect(failure.errors[0]).toBe(primary);
    expect(String(failure.errors[1])).toContain("ownership changed");
  }
);

it("renders ordered aggregate members through the proposal CLI without changing its error exit", async () => {
  const cacheRoot = root();
  const worksetPath = join(cacheRoot, "workset.json");
  writeFileSync(worksetPath, JSON.stringify(workset));
  vi.spyOn(proposals, "prepareSemanticProposal").mockImplementation(() => {
    throw new AggregateError([new Error("original preparation failure"), new Error("lease release failure")],
      "paired fill failure");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exitCode = await runSemanticProposalFillCommand([
    "--action", "prepare", "--kind", "query", "--workset", worksetPath,
    "--cache-root", cacheRoot, "--preflight-out", join(cacheRoot, "preflight.json")
  ]);
  expect(exitCode).toBe(2);
  expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join(""))
    .toMatch(/original preparation failure.*lease release failure/su);
});
