import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import { classifyProposalOutcome } from "../../runs/semantic-proposal/fill.js";

it("retries only transport and malformed JSON proposal failures", () => {
  expect(classifyProposalOutcome({ status: "interpreted" })).toBe("admitted");
  expect(classifyProposalOutcome({ status: "abstained" })).toBe("admitted");
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
      contract: "source-semantic-proposal-workset-v1",
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

afterEach(() => {
  /* capture restores in tests */
});
