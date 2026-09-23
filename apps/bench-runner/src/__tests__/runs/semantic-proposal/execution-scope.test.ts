import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";

const model = "gemini-3.1-flash-lite", requestProfile = "gemini-3.1-minimal-v1" as const;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function root() { const value = mkdtempSync(join(tmpdir(), "proposal-execution-scope-")); roots.push(value); return value; }
function workset(provider_url: string) {
  return parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
    model, request_profile: requestProfile, provider_url, items: [{ original_query: "Who reported that Lee left?" }] });
}
function pin(prepared: ReturnType<typeof workset>, cacheRoot: string) {
  return pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(prepared, cacheRoot, 128, 1),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
}
function config(providerUrl: string) { return { model, requestProfile, providerUrl, apiKey: "loopback-only" }; }
async function loopback() {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1; response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      contract: "source-semantic-query-response-v7", outcome: { status: "abstained" }
    }) }] } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits,
    close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("keeps preflight read-only and initializes its physical execution root only on authorization", () => {
  const parent = root(), cacheRoot = join(parent, "cache"), prepared = workset("http://127.0.0.1:9");
  const preflight = prepareSemanticProposal(prepared, cacheRoot, 128, 1);
  expect(existsSync(cacheRoot)).toBe(false);
  expect(preflight.execution_scope.execution_root_binding).toBeNull();
  const authority = pinSemanticProposalAuthority({ preflight, inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  expect(authority.execution_scope.execution_root_binding).not.toBeNull();
  expect(listExtractionAttemptLedgerRecords(cacheRoot)).toEqual([]);
  expect(prepareSemanticProposal(prepared, cacheRoot, 128, 1).execution_scope).toEqual(authority.execution_scope);
});

it("prepares nested absent ancestors without writes and binds the root created by authorization", async () => {
  const http = await loopback();
  try {
    const parent = root(), output = join(parent, "future", "run"), cacheRoot = join(output, "query-cache");
    const prepared = workset(http.origin), preflight = prepareSemanticProposal(prepared, cacheRoot, 128, 1);
    expect(preflight.execution_scope.execution_root_path).toBe(cacheRoot);
    expect(readdirSync(parent)).toEqual([]);
    const authority = pinSemanticProposalAuthority({ preflight, inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
    expect(existsSync(cacheRoot)).toBe(true);
    expect(await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: config(http.origin) }))
      .toMatchObject({ abstained: 1, attempts: 1 });
    const retained = join(output, "retained"); renameSync(cacheRoot, retained); cpSync(retained, cacheRoot, { recursive: true });
    await expect(executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: config(http.origin) }))
      .rejects.toThrow(/target root changed/u);
    expect(http.hits()).toBe(1);
  } finally { await http.close(); }
});

it.each(["file", "dangling-symlink"] as const)("does not treat an unresolved %s ancestor as an absent output directory", mode => {
  const parent = root(), obstruction = join(parent, "ancestor");
  if (mode === "file") writeFileSync(obstruction, "retained");
  else symlinkSync(join(parent, "missing-target"), obstruction, "dir");
  expect(() => prepareSemanticProposal(workset("http://127.0.0.1:9"), join(obstruction, "run", "cache"), 128, 1)).toThrow();
  expect(readdirSync(parent)).toEqual(["ancestor"]);
});

it("rejects another execution root without renewing a one-attempt unknown reservation or making HTTP requests", async () => {
  const http = await loopback();
  try {
    const cacheRoot = root(), otherRoot = root(), prepared = workset(http.origin), authority = pin(prepared, cacheRoot);
    const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
    ledger.reserveAttemptOrdinal(authority.keys[0]!);
    const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
    const reserved = readFileSync(ledgerPath, "utf8");
    expect(await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: config(http.origin) }))
      .toMatchObject({ unknown: 1, attempts: 1, newly_admitted: 0 });
    await expect(executeSemanticProposalFill({ workset: prepared, cacheRoot: otherRoot, authority, config: config(http.origin) }))
      .rejects.toThrow(/execution root differs/u);
    expect(() => openSemanticProposalAttemptLedger({ cacheRoot: otherRoot, authority, kind: "query" }))
      .toThrow(/execution root differs/u);
    expect(http.hits()).toBe(0);
    expect(readdirSync(otherRoot)).toEqual([]);
    expect(readFileSync(ledgerPath, "utf8")).toBe(reserved);
    expect(readSemanticProposalResults(prepared, cacheRoot, 128)[0]?.status).toBe("unknown");
  } finally { await http.close(); }
});

it.each(["recreated", "symlink"] as const)("rejects a %s root even with copied marker and ledger bytes", async mode => {
  const http = await loopback();
  try {
    const parent = root(), cacheRoot = join(parent, "cache"), retainedRoot = join(parent, "retained");
    const prepared = workset(http.origin), authority = pin(prepared, cacheRoot);
    openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).reserveAttemptOrdinal(authority.keys[0]!);
    const preflight = prepareSemanticProposal(prepared, cacheRoot, 128, 1);
    renameSync(cacheRoot, retainedRoot);
    if (mode === "recreated") cpSync(retainedRoot, cacheRoot, { recursive: true });
    else symlinkSync(retainedRoot, cacheRoot, "dir");
    const bytes = readFileSync(join(retainedRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`), "utf8");
    await expect(executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: config(http.origin) }))
      .rejects.toThrow(/target root changed/u);
    expect(() => pinSemanticProposalAuthority({ preflight, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }))
      .toThrow(/target root changed/u);
    expect(http.hits()).toBe(0);
    expect(readFileSync(join(retainedRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`), "utf8")).toBe(bytes);
  } finally { await http.close(); }
});

it("accepts a canonical parent alias for the same physical root and preserves completed replay", async () => {
  const http = await loopback();
  try {
    const parent = root(), physical = join(parent, "physical"), alias = join(parent, "alias");
    mkdirSync(physical); symlinkSync(physical, alias, "dir");
    const cacheRoot = join(physical, "cache"), prepared = workset(http.origin), authority = pin(prepared, cacheRoot);
    expect(await executeSemanticProposalFill({ workset: prepared, cacheRoot: join(alias, "cache"), authority, config: config(http.origin) }))
      .toMatchObject({ abstained: 1, attempts: 1 });
    expect(await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: config(http.origin) }))
      .toMatchObject({ abstained: 1, cache_hits: 1 });
    expect(http.hits()).toBe(1);
  } finally { await http.close(); }
});

it("retains unbound historical cache bytes as read-only evidence instead of silently granting execution", () => {
  const cacheRoot = root(), prepared = workset("http://127.0.0.1:9");
  const preflight = prepareSemanticProposal(prepared, cacheRoot, 128, 1);
  const historical = "retained original authority and raw evidence\n";
  writeFileSync(join(cacheRoot, "historical.json"), historical);
  expect(() => pinSemanticProposalAuthority({ preflight, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }))
    .toThrow(/read-only evidence, not an execution grant/u);
  expect(() => prepareSemanticProposal(prepared, cacheRoot, 128, 1)).toThrow(/read-only evidence/u);
  expect(readFileSync(join(cacheRoot, "historical.json"), "utf8")).toBe(historical);
  expect(readdirSync(cacheRoot)).toEqual(["historical.json"]);
});

it("ignores unrelated host Git revision drift and preserves existing unknown reservations", async () => {
  const http = await loopback();
  try {
    const directory = root(), checkout = join(directory, "checkout"), cacheRoot = join(directory, "cache");
    mkdirSync(checkout);
    const git = (args: readonly string[]) => execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
    git(["init", "--quiet"]); writeFileSync(join(checkout, "host-only.ts"), "export const admissionRevision = 1;\n");
    git(["add", "host-only.ts"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    const worksetPath = join(directory, "workset.json"); writeFileSync(worksetPath, JSON.stringify(workset(http.origin)));
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "proposal-process-fixture.mjs");
    const child = spawn(process.execPath, [fixture], { cwd: join(dirname(fixture), "../../../../../.."),
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PROPOSAL_PROCESS_MODE: "revision-drift",
        PROPOSAL_CACHE_ROOT: cacheRoot, PROPOSAL_GIT_ROOT: checkout, PROPOSAL_WORKSET_PATH: worksetPath } });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("exit", code => resolve({ code, stdout, stderr }));
    });
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ request_unchanged: true, revision_changed: false,
      scope_unchanged: true,
      unknown_preserved: true, lineage_unchanged: true, ledger_count: 1, resumed: { unknown: 1, attempts: 1 } });
    expect(http.hits()).toBe(0);
  } finally { await http.close(); }
}, 40_000);

it("rejects a foreign implementation pin before creating the query execution root", () => {
  const cacheRoot = join(root(), "cache"), prepared = workset("http://127.0.0.1:9");
  const preflight = prepareSemanticProposal(prepared, cacheRoot, 128, 1);
  const wrong = { ...preflight, execution_scope: {
    ...preflight.execution_scope,
    implementation_revision: `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}`
  } };
  expect(() => pinSemanticProposalAuthority({ preflight: wrong, inputUsdPerMillion: 1,
    outputUsdPerMillion: 2 })).toThrow(/executable revision changed/u);
  expect(existsSync(cacheRoot)).toBe(false);
});
