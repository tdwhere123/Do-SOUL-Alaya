import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../../cli/index.js";
import { classifyProposalOutcome, prepareSemanticProposal } from "../../runs/semantic-proposal/fill.js";
import { parseSemanticProposalWorkset } from "../../runs/semantic-proposal/workset.js";
import { pinSemanticProposalAuthority } from "../../runs/semantic-proposal/authority.js";
import { listExtractionAttemptLedgerRecords } from "../../runs/extraction/authority/attempt-ledger.js";

it("retries only transport and malformed JSON proposal failures", () => {
  expect(classifyProposalOutcome({ status: "interpreted" })).toBe("interpreted");
  expect(classifyProposalOutcome({ status: "abstained" })).toBe("abstained");
  expect(classifyProposalOutcome({ status: "interpreted" }, null)).toBe("incomplete");
  expect(classifyProposalOutcome({ status: "interpreted" }, "MAX_TOKENS")).toBe("incomplete");
  expect(classifyProposalOutcome({ status: "transport_failure" })).toBe("retryable");
  expect(classifyProposalOutcome({ status: "invalid", reason: "malformed_json" })).toBe("retryable");
  expect(classifyProposalOutcome({ status: "invalid", reason: "malformed_response" })).toBe("terminal");
  expect(classifyProposalOutcome({ status: "invalid", reason: "query_digest_mismatch" })).toBe("terminal");
});

it("rejects semantic-proposal-fill without a workset", async () => {
  const stderr = capture(process.stderr);
  try {
    expect(await runCli(["semantic-proposal-fill", "--kind", "query", "--action", "prepare"])).toBe(2);
    expect(stderr.buf).toMatch(/--workset is required/u);
  } finally {
    stderr.restore();
  }
});

it("prepares a query workset without provider calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semantic-proposal-fill-"));
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("provider calls are forbidden during prepare");
  };
  try {
    const workset = join(directory, "workset.json");
    const preflight = join(directory, "preflight.json");
    await writeFile(workset, `${JSON.stringify({
      contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
      kind: "query",
      model: "gemini-3.1-flash-lite",
      request_profile: "gemini-3.1-minimal-v1",
      items: [{ original_query: "Who chairs SHADOW?" }]
    }, null, 2)}\n`);
    expect(await runCli([
      "semantic-proposal-fill", "--kind", "query", "--action", "prepare",
      "--workset", workset, "--cache-root", join(directory, "cache"),
      "--preflight-out", preflight
    ])).toBe(0);
  } finally {
    globalThis.fetch = fetch;
    await rm(directory, { recursive: true, force: true });
  }
});

function capture(stream: NodeJS.WriteStream) {
  const original = stream.write.bind(stream);
  let buf = "";
  stream.write = ((chunk: string | Uint8Array) => {
    buf += chunk.toString();
    return true;
  }) as typeof stream.write;
  return {
    get buf() { return buf; },
    restore() { stream.write = original; }
  };
}

it("rejects a CLI environment endpoint override before dispatch or reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semantic-proposal-endpoint-"));
  const cacheRoot = join(directory, "cache"), worksetPath = join(directory, "workset.json"), authorityPath = join(directory, "authority.json");
  const prepared = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
    model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1", provider_url: "http://127.0.0.1:9",
    items: [{ original_query: "Who reported that Lee left?" }] });
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await writeFile(worksetPath, JSON.stringify(prepared)); await writeFile(authorityPath, JSON.stringify(authority));
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "http://127.0.0.1:10");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", ""); vi.stubEnv("OFFICIAL_API_GARDEN_API_KEY", "loopback-only");
  const fetch = vi.fn(() => { throw new Error("unapproved dispatch"); }); vi.stubGlobal("fetch", fetch);
  const stderr = capture(process.stderr);
  try {
    expect(await runCli(["semantic-proposal-fill", "--kind", "query", "--action", "fill", "--workset", worksetPath,
      "--cache-root", cacheRoot, "--authority", authorityPath])).toBe(2);
    expect(stderr.buf).toContain("actual HTTP request differs from authorized request");
    expect(fetch).not.toHaveBeenCalled(); expect(listExtractionAttemptLedgerRecords(cacheRoot)).toEqual([]);
  } finally { stderr.restore(); await rm(directory, { recursive: true, force: true }); }
});

afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
