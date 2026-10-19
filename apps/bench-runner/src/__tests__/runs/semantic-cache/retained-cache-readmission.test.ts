import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSourceSemanticProposalRevision } from "@do-soul/alaya-soul";
import * as queryOwner from "@do-soul/alaya-soul";
import { seedRetainedSemanticCache } from "./retained-cache.test-support.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { readSemanticProposalResults } from "../../../runs/semantic-cache/results.js";
import { semanticProposalLookup, semanticProposalCacheInputPaths } from "../../../runs/semantic-cache/attempt.js";
import { semanticProposalShardPath } from "../../../runs/semantic-cache/artifact.js";
import { ledgerPath } from "../../../runs/extraction/authority/attempt-ledger.js";
import { providerRawAttemptPath } from "../../../runs/extraction/fill/provider-raw-attempt.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const raw = JSON.stringify({ contract: "source-semantic-query-response-v8", outcome: { status: "abstained" } });
function fixture(chat = false) {
  const root = mkdtempSync(join(tmpdir(), "retained-cache-")); roots.push(root);
  const cache = join(root, "cache");
  const workset = parseSemanticProposalWorkset({ contract: chat ? "source-semantic-proposal-workset-v4" : "source-semantic-proposal-workset-v3", kind: "query",
    model: chat ? "step-3.5-flash-2603" : "gemini-3.1-flash-lite",
    request_profile: chat ? "step-3.5-2603-low-json-schema-v1" : "gemini-3.1-minimal-v1",
    provider_url: chat ? "https://api.stepfun.com/v1" : "http://127.0.0.1:9",
    items: [{ original_query: "Who reported that Lee left?" }] });
  const line = materializeSemanticProposalLines(workset, 128)[0]!;
  const shard = semanticProposalShardPath(cache, line.key), physical = providerRawAttemptPath(cache, line.key, 1);
  const ledger = ledgerPath(cache, semanticProposalLookup(workset, line, 128).attempt_lineage_digest!);
  return { root, cache, workset, line, shard, physical, ledger };
}

it("reads complete retained evidence without dispatch or rewriting shard, raw or ledger bytes", () => {
  const f = fixture(), fetch = vi.fn(() => { throw new Error("provider forbidden"); }); vi.stubGlobal("fetch", fetch);
  seedRetainedSemanticCache(f.workset, f.cache, 128, () => raw);
  const paths = [f.shard, f.physical, f.ledger], before = paths.map(path => readFileSync(path, "utf8"));
  expect(readSemanticProposalResults(f.workset, f.cache, 128)[0]?.status).toBe("abstained");
  expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(before); expect(fetch).not.toHaveBeenCalled();
});
it("distinguishes an absent cache from an unresolved reserved attempt", () => {
  const f = fixture();
  expect(readSemanticProposalResults(f.workset, f.cache, 128)[0]?.status).toBe("unattempted");
  seedRetainedSemanticCache(f.workset, f.cache, 128, () => raw);
  rmSync(f.shard); rmSync(f.physical);
  const ledger = JSON.parse(readFileSync(f.ledger, "utf8"));
  ledger.settled_attempts = []; ledger.unresolved_attempts = [{ attempt_ordinal: 1, cache_key: f.line.key }];
  ledger.pending_keys = [f.line.key]; writeFileSync(f.ledger, JSON.stringify(ledger));
  expect(readSemanticProposalResults(f.workset, f.cache, 128)[0]?.status).toBe("unknown");
});
it.each(["shard", "raw", "ledger"] as const)("rejects malformed retained %s rather than caching successful absence", part => {
  const f = fixture(); seedRetainedSemanticCache(f.workset, f.cache, 128, () => raw);
  writeFileSync(part === "shard" ? f.shard : part === "raw" ? f.physical : f.ledger, "{invalid");
  expect(() => readSemanticProposalResults(f.workset, f.cache, 128)).toThrow();
});
it.each(["request_digest", "attempt_lineage_digest", "decoded_text"] as const)("rejects changed physical raw %s", field => {
  const f = fixture(); seedRetainedSemanticCache(f.workset, f.cache, 128, () => raw);
  const physical = JSON.parse(readFileSync(f.physical, "utf8")); physical[field] = field === "decoded_text" ? "changed" : "a".repeat(64);
  writeFileSync(f.physical, JSON.stringify(physical));
  expect(() => readSemanticProposalResults(f.workset, f.cache, 128)).toThrow();
});
it("readmits a cached revision only against its isolated complete physical parent", () => {
  const f = fixture(); seedRetainedSemanticCache(f.workset, f.cache, 128, () => raw);
  const revision = prepareSourceSemanticProposalRevision({ kind: "query", parent_request: f.line.request,
    previous_response: raw, response_completion: "complete" });
  const child = parseSemanticProposalWorkset({ ...f.workset, revision_parent_cache_root: f.cache,
    items: [{ original_query: f.line.original_query, revision }] });
  const childRoot = join(f.root, "child");
  seedRetainedSemanticCache(child, childRoot, 128, () => raw);
  expect(readSemanticProposalResults(child, childRoot, 128)[0]?.status).toBe("abstained");
  expect(() => readSemanticProposalResults(child, f.cache, 128)).toThrow(/isolated child cache root/u);
  rmSync(f.physical);
  expect(() => readSemanticProposalResults(child, childRoot, 128)).toThrow();
});

it("binds a historical query parent to its exact prompt, wire identity and physical cache without rewriting it", () => {
  const f = fixture(true);
  const prompt = vi.spyOn(queryOwner, "sourceSemanticQuerySystemPrompt").mockReturnValue("Retained historical query guidance.");
  const historical = materializeSemanticProposalLines(f.workset, 128)[0]!;
  seedRetainedSemanticCache(f.workset, f.cache, 128, () => raw); prompt.mockRestore();
  expect(materializeSemanticProposalLines(f.workset, 128)[0]!.key).not.toBe(historical.key);
  const retainedParent = { key: historical.key, request_digest: historical.requestDigest,
    system_prompt: historical.systemPrompt, model: f.workset.model, request_profile: f.workset.request_profile,
    provider_url: f.workset.provider_url, max_output_tokens: 128 };
  const revision = prepareSourceSemanticProposalRevision({ kind: "query", parent_request: historical.request,
    previous_response: raw, response_completion: "complete" });
  const item = { original_query: historical.original_query, revision, retained_parent: retainedParent };
  const child = parseSemanticProposalWorkset({ ...f.workset, revision_parent_cache_root: f.cache, items: [item] });
  const childRoot = join(f.root, "child"), path = semanticProposalShardPath(f.cache, historical.key);
  const original = readFileSync(path, "utf8");
  expect(readSemanticProposalResults(child, childRoot, 128)[0]?.status).toBe("unattempted");
  expect(semanticProposalCacheInputPaths(child, childRoot, 128)).toContain(path);
  expect(semanticProposalCacheInputPaths(child, childRoot, 128)).not.toContain(f.shard);
  for (const [field, value] of [["model", "different-model"], ["request_profile", "gemini-3.1-minimal-v1"],
    ["provider_url", "http://127.0.0.1:10"], ["max_output_tokens", 129], ["key", "a".repeat(64)],
    ["request_digest", "b".repeat(64)], ["system_prompt", "Changed guidance."]] as const) {
    const changed = { ...child, items: [{ ...item, retained_parent: { ...retainedParent, [field]: value } }] };
    expect(() => readSemanticProposalResults(changed, childRoot, 128)).toThrow();
  }
  expect(() => materializeSemanticProposalLines({ ...f.workset,
    items: [{ original_query: historical.original_query, retained_parent: retainedParent }] }, 128)).toThrow(/requires a revision/u);
  expect(readFileSync(path, "utf8")).toBe(original);
});
