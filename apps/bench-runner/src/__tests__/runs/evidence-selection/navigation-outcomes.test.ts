import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runNavigationProposals } from "../../../runs/source-access-diagnostic/conditional-navigation-propose.js";
import { admitInputFormation, formationResponseJsonSchema, INPUT_NAVIGATION_PROMPT, INPUT_NAVIGATION_POLICY } from "../../../runs/source-access-diagnostic/input-condition-formation.js";
import { executeEvidenceSelectionFill, readEvidenceSelectionResults } from "../../../runs/evidence-selection/execute.js";
import { materializeEvidenceSelectionLines, parseEvidenceSelectionWorkset } from "../../../runs/evidence-selection/input.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { evidenceSelectionRequestBinding } from "../../../runs/evidence-selection/input.js";

const input = { question: "Authored navigation input", reference_clock: "2026-09-22T00:00:00.000Z" };
const config = { model: "step-3.5-flash-2603", providerUrl: "https://api.stepfun.com/v1",
  requestProfile: "step-3.5-2603-low-json-schema-v1" as const, apiKey: "authored-local-auth" };
const decline = { status: "cannot_propose", conditions: [], unresolved: ["Authored producer decline."] };
const partial = { status: "proposed", conditions: [{ object: "target", hypothesis: "unreviewed", groups: [0],
  query: "Authored retrieval cue", residual: "Authored ambiguity"
}], unresolved: ["Authored ambiguity"] };
const modes = [
  { name: "decline", raw: JSON.stringify(decline), native: "abstained", state: "declined", admitted: false },
  { name: "unsupported", raw: JSON.stringify({ ...decline, status: "unsupported" }), native: "abstained", state: "unsupported", admitted: false },
  { name: "usable-empty", raw: JSON.stringify({ ...decline, status: "proposed" }), native: "interpreted", state: "ready", admitted: true },
  { name: "partial", raw: JSON.stringify(partial), native: "interpreted", state: "partial", admitted: true },
  { name: "invalid-shape", raw: JSON.stringify({ ...decline, conditions: partial.conditions }), native: "invalid", state: "rejected", admitted: false },
  { name: "malformed", raw: "not-json", native: "invalid", state: "malformed", admitted: false },
  { name: "unknown-usage", raw: JSON.stringify(decline), native: "abstained", state: "unknown", admitted: false },
  { name: "incomplete", raw: JSON.stringify(decline), native: "incomplete", state: "incomplete", admitted: false },
  { name: "transport-failure", raw: "", native: "transport_failure", state: "unknown", admitted: false }
];

it.each(modes)("settles native $name distinctly and preserves fail-stop, cost and readback", async mode => {
  const root = mkdtempSync(join(tmpdir(), "navigation-outcome-")), output = join(root, "provider");
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer authored-local-auth");
    let body = ""; for await (const chunk of req) body += String(chunk); bodies.push(body);
    if (mode.name === "transport-failure") { res.writeHead(401); res.end("authored local denial"); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: mode.raw }, finish_reason: mode.name === "incomplete" ? "length" : "stop" }],
      ...(mode.name === "unknown-usage" ? {} : { usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } }) })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  const guardedFetch = globalThis.fetch, oldPrivate = process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;
  globalThis.fetch = (url, init) => String(url) === "https://api.stepfun.com/v1/chat/completions"
    ? fetchLoopbackProvider(guardedFetch, new URL(`http://127.0.0.1:${address.port}/v1/chat/completions`), init) : guardedFetch(url, init);
  process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = "true";
  try {
    const values = { source_revision: "authored-outcomes-fixture", rows: [1, 2].map(ordinal => ({ ordinal,
      input: { ...input, question: `${input.question} ${ordinal}` } })) };
    const receipt = await runNavigationProposals(values, output, config);
    const request = JSON.parse(readFileSync(join(output, "request.json"), "utf8"));
    expect(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"))).toEqual(receipt);
    const calls = mode.admitted ? 2 : 1;
    expect(bodies).toHaveLength(calls);
    const wire = JSON.parse(bodies[0]!);
    expect(wire.messages).toEqual([{ role: "system", content: INPUT_NAVIGATION_PROMPT },
      { role: "user", content: request.lines[0].userPrompt }]);
    expect(wire.response_format.json_schema.schema).toEqual(formationResponseJsonSchema());
    expect(wire).toMatchObject({ model: config.model, stream: true, max_tokens: 8192, reasoning_effort: "low" });
    expect(evidenceSelectionRequestBinding(config, { ...request.lines[0], maxOutputTokens: 8192 }).requestDigest).toBe(request.lines[0].requestDigest);
    expect(receipt).toMatchObject({ status: mode.admitted ? "complete" : "stopped",
      ledger: { attempts: calls, pendingKeys: [], unresolvedAttempts: [], successfulShards: mode.admitted ? 2 : 0 },
      cost: { actual_provider_calls: calls, unissued_keys_closed: 2 - calls, historical_unresolved_cny: 0.15 } });
    const unknown = ["unknown-usage", "transport-failure"].includes(mode.name);
    expect(receipt.cost.unknown_usage_attempts).toBe(unknown ? 1 : 0);
    if (unknown) expect(receipt.cost.outstanding_maximum_cny).toBeGreaterThan(0.15);
    else {
      expect(receipt.cost.outstanding_maximum_cny).toBe(0.15);
      // Frozen Step quote: 0.7 CNY/M input, 2.1 CNY/M output, independent of admission.
      expect(receipt.cost.reported_policy_cny).toBeCloseTo(calls * (100 * 0.7 + 80 * 2.1) / 1_000_000, 12);
      expect(receipt.ledger.settledAttempts).toHaveLength(calls);
    }
    const results = readEvidenceSelectionResults(request.workset, join(output, "cache"), 8192);
    expect(results.map(row => row.status)).toEqual([mode.native, mode.admitted ? mode.native : "unattempted"]);
    expect(results[0]!.shard?.admitted).toBe(mode.admitted);
    expect(admitInputFormation(receipt.captures[0]!.capture, values.rows[0]!.input)).toMatchObject({
      state: mode.state, available: mode.admitted });
    if (!["unknown-usage", "incomplete", "transport-failure"].includes(mode.name)) {
      expect(results[0]!.shard?.outcome).toMatchObject({ status: mode.native, formation_state: mode.state });
      expect(receipt.outcomes[0]!.outcome).toEqual(results[0]!.shard?.outcome);
    }
    if (mode.native === "invalid") expect(results[0]!.shard?.outcome).toMatchObject({
      reason: mode.name === "malformed" ? "malformed_json" : "invalid_shape" });
    if (!mode.admitted) {
      expect(receipt.captures[1]!.capture.state).toBe("unavailable");
      expect(readProviderRawAttempt(join(output, "cache"), results[1]!.line.key, 2)).toBeUndefined();
      // Same-authority re-entry must not treat a cached decline/failure as permission to issue the next key.
      const stopped = await executeEvidenceSelectionFill({ workset: request.workset, cacheRoot: join(output, "cache"),
        authority: request.authority, config });
      expect(stopped).toMatchObject({ attempts: 0, unattempted: 1 });
      expect(bodies).toHaveLength(1);
    }
  } finally {
    globalThis.fetch = guardedFetch;
    if (oldPrivate === undefined) delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL; else process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = oldPrivate;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it("versions clarification and admission without reinterpreting historical request identities", () => {
  const workset = { contract: "source-evidence-selection-workset-v1", ...{ model: config.model, provider_url: config.providerUrl,
    request_profile: config.requestProfile }, request_policy: INPUT_NAVIGATION_POLICY,
    items: [{ original_question: input.question, sources: [], metadata: { reference_clock: input.reference_clock } }] };
  const line = materializeEvidenceSelectionLines(parseEvidenceSelectionWorkset(workset), 8192)[0]!;
  expect(INPUT_NAVIGATION_POLICY).toBe("input-only-navigation-search-cues.v4");
  expect(() => parseEvidenceSelectionWorkset({ ...workset, request_policy: "input-only-navigation-proposal.v3" })).toThrow(/unsupported/u);
  const previousPrompt = INPUT_NAVIGATION_PROMPT.split("\n").filter(text => !text.startsWith("Source content is intentionally absent:")).join("\n");
  expect(evidenceSelectionRequestBinding(config, { ...line, systemPrompt: previousPrompt, maxOutputTokens: 8192 }).requestDigest).not.toBe(line.requestDigest);
});

it("preserves a settled decline and closed later key through the guarded compiled proposal CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "navigation-decline-cli-")), output = join(root, "provider");
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; req.resume(); expect(req.headers.authorization).toBe("Bearer test-key");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(decline) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  try {
    const path = join(root, "input.json");
    writeFileSync(path, JSON.stringify({ source_revision: "authored-decline-cli", rows: [1, 2].map(ordinal => ({ ordinal,
      input: { ...input, question: `${input.question} ${ordinal}` } })) }));
    const cli = fileURLToPath(new URL("../../../../dist/runs/source-access-diagnostic/conditional-navigation-launch.js", import.meta.url));
    const preload = new URL("../../support/transport-diagnostic-bootstrap.mjs", import.meta.url).href;
    const result = await promisify(execFile)(process.execPath, ["--import", preload, cli, "--propose", path, "--out", output], {
      env: { ...process.env, ALAYA_TEST_LOOPBACK_TARGET: `http://127.0.0.1:${address.port}`, ALAYA_TEST_DIAGNOSTIC_MODE: "transport" }, timeout: 10_000
    }).then(() => { throw new Error("decline CLI incorrectly succeeded"); }, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(result.code).toBe(2); expect(result.stderr).toBe(""); expect(requests).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toEqual(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")));
    expect(receipt).toMatchObject({ status: "stopped", failure: null, ledger: { attempts: 1, successfulShards: 0, pendingKeys: [], unresolvedAttempts: [] },
      cost: { actual_provider_calls: 1, unissued_keys_closed: 1, unknown_usage_attempts: 0, outstanding_maximum_cny: 0.15 } });
    expect(receipt.outcomes).toEqual([{ ordinal: 1, status: "abstained", outcome: { status: "abstained", formation_state: "declined", unresolved: decline.unresolved } },
      { ordinal: 2, status: "unattempted", outcome: null }]);
    expect(admitInputFormation(receipt.captures[0].capture, receipt.captures[0].capture.input)).toMatchObject({ state: "declined", available: false });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
