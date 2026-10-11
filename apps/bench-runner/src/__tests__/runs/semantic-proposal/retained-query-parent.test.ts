import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as semanticProposals from "@do-soul/alaya-soul";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { semanticProposalCacheInputPaths, semanticProposalLookup } from "../../../runs/semantic-proposal/attempt.js";
import { executeSemanticProposalFill, prepareRetainedSemanticProposalRevision, prepareSemanticProposal,
  readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset, resolveSemanticProposalRevisionParent,
  type RetainedSemanticQueryParent, type SemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { ledgerPath } from "../../../runs/extraction/authority/attempt-ledger.js";
import { providerRawAttemptPath } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { admitEvaluatorOutputRoot } from "../../../runs/measurement/evaluator-output.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
  const answer = { address: "93.184.216.34", family: 4 }; return options?.all ? [answer] : answer;
}) }));

const roots: string[] = [];
const query = "Who sent the sample to Mira?";
const queryItem = { original_query: query, generation_presentation: "nested-meaning-v1" as const };
const cap = 128;
const config = { providerUrl: STEP_OPENAPI_QUOTE_BASIS.selected_provider_url, model: STEP_OPENAPI_QUOTE_BASIS.selected_model,
  requestProfile: "step-3.5-2603-low-json-schema-v1" as const, apiKey: "fixture-only" };
const rates = { inputUsdPerMillion: STEP_OPENAPI_QUOTE_BASIS.input_usd_equivalent_per_million,
  outputUsdPerMillion: STEP_OPENAPI_QUOTE_BASIS.output_usd_equivalent_per_million };
const rawJson = JSON.stringify({ contract: "source-semantic-query-response-v9", outcome: { status: "interpreted" },
  query: { contract: "source-semantic-query-meaning-v5", entities: [
    { kind: "free", key: "sender", excerpt: "Who", return: true },
    { kind: "named", key: "sample", excerpt: "sample" }, { kind: "named", key: "mira", excerpt: "Mira" }
  ], alternatives: [{ conditions: [{
    kind: "statement", key: "send", predicate: "send", arguments: [
      { role: "sender", target: { kind: "reference", key: "sender" }, excerpt: "Who" },
      { role: "theme", target: { kind: "reference", key: "sample" }, excerpt: "sample" },
      { role: "recipient", target: { kind: "reference", key: "mira" }, excerpt: "Mira" }
    ]
  }] }], gaps: [] } });

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function provider(finishReason = "stop") {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: rawJson }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`;
  const fetchImpl: typeof fetch = vi.fn(async () => new Response(body,
    { status: 200, headers: { "content-type": "text/event-stream" } }));
  const extractor = createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl);
  return { extract: vi.fn(extractor.extract) };
}

async function retainedFixture(finish = "stop", changedSchema = false) {
  const root = mkdtempSync(join(tmpdir(), "retained-query-parent-")); roots.push(root);
  const parentRoot = join(root, "parent"), childRoot = join(root, "child");
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: config.model, request_profile: config.requestProfile, provider_url: config.providerUrl,
    items: [queryItem] });
  // Only the historical generation differs. All physical writes go through the native fill owners.
  vi.spyOn(semanticProposals, "sourceSemanticQuerySystemPrompt").mockReturnValue("Retained historical query guidance.");
  if (changedSchema) {
    const schema = semanticProposals.sourceSemanticQueryResponseJsonSchema(
      materializeSemanticProposalLines(workset, cap)[0]!.request as semanticProposals.SourceSemanticQueryRequest);
    vi.spyOn(semanticProposals, "sourceSemanticQueryResponseJsonSchema")
      .mockReturnValue({ ...schema, allOf: [{ required: ["historical_required_field"] }] });
  }
  const line = materializeSemanticProposalLines(workset, cap)[0]!;
  const retained: RetainedSemanticQueryParent = { key: line.key, request_digest: line.requestDigest,
    system_prompt: line.systemPrompt, model: workset.model, request_profile: workset.request_profile,
    provider_url: workset.provider_url, max_output_tokens: cap };
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, parentRoot, cap, 1),
    ...rates });
  const extractor = provider(finish);
  const fill = executeSemanticProposalFill({ workset, cacheRoot: parentRoot, authority, config, extractor });
  if (finish === "length") await expect(fill).rejects.toThrow(/stopped after incomplete/u);
  else await fill;
  vi.restoreAllMocks();
  const prepare = (overrides: Partial<Parameters<typeof prepareRetainedSemanticProposalRevision>[0]> = {}) =>
    prepareRetainedSemanticProposalRevision({ workset, parentCacheRoot: parentRoot, maxOutputTokens: cap,
      itemIndex: 0, retainedParent: retained, ...overrides });
  const child = (): SemanticProposalWorkset => parseSemanticProposalWorkset({ ...workset,
    revision_parent_cache_root: parentRoot, items: [{ ...queryItem, revision: prepare(), retained_parent: retained }] });
  return { root, parentRoot, childRoot, workset, line, retained, extractor, prepare, child };
}

it("prepares a current-guidance child from the complete historical physical parent without reserving an attempt", async () => {
  const fixture = await retainedFixture();
  const { workset, parentRoot, childRoot, line, retained } = fixture;
  const current = materializeSemanticProposalLines(workset, cap)[0]!;
  expect(current.request).toEqual(line.request);
  expect(current.responseJsonSchema).toEqual(line.responseJsonSchema);
  expect(current.key).not.toBe(line.key);
  expect(() => fixture.prepare({ retainedParent: undefined })).toThrow(/complete physical parent/u);
  const shardPath = semanticProposalShardPath(parentRoot, line.key);
  const rawPath = providerRawAttemptPath(parentRoot, line.key, 1);
  const ledger = ledgerPath(parentRoot, semanticProposalLookup(workset, line, cap).attempt_lineage_digest!);
  const before = [shardPath, rawPath, ledger].map(path => readFileSync(path, "utf8"));
  const child = fixture.child(), revision = fixture.prepare();
  expect(revision.previous_response).toBe(rawJson);
  const childLine = materializeSemanticProposalLines(child, cap)[0]!;
  expect(childLine.systemPrompt).toBe(semanticProposals.sourceSemanticQuerySystemPrompt(
    childLine.request as semanticProposals.SourceSemanticQueryRequest));
  expect(childLine.systemPrompt).not.toBe(retained.system_prompt);
  expect(childLine.userPrompt).not.toContain("retained_parent");
  expect(childLine.key).not.toBe(line.key);
  expect(prepareSemanticProposal(child, childRoot, cap, 1).keys).toEqual([childLine.key]);
  expect(readSemanticProposalResults(child, childRoot, cap)[0]?.status).toBe("unattempted");
  expect(existsSync(childRoot)).toBe(false);
  expect([shardPath, rawPath, ledger].map(path => readFileSync(path, "utf8"))).toEqual(before);
  expect(fixture.extractor.extract).toHaveBeenCalledTimes(1);
  expect(() => prepareSemanticProposal(child, parentRoot, cap, 1)).toThrow(/isolated child cache root/u);
  const alias = join(fixture.root, "parent-alias"); symlinkSync(parentRoot, alias, "dir");
  expect(() => prepareSemanticProposal(child, alias, cap, 1)).toThrow(/not a real directory/u);
});

it("validates the retained reference again when filling and reading a current child", async () => {
  const fixture = await retainedFixture(), child = fixture.child();
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(child, fixture.childRoot, cap, 1),
    ...rates });
  const extractor = provider();
  const changed = { ...child, items: [{ ...queryItem, revision: fixture.prepare(),
    retained_parent: { ...fixture.retained, key: "a".repeat(64) } }] };
  await expect(executeSemanticProposalFill({ workset: changed, cacheRoot: fixture.childRoot, authority, config, extractor }))
    .rejects.toThrow(/unchanged request, schema or wire identity/u);
  expect(extractor.extract).not.toHaveBeenCalled();
  const result = await executeSemanticProposalFill({ workset: child, cacheRoot: fixture.childRoot, authority, config, extractor });
  expect(result).toMatchObject({ interpreted: 1, attempts: 1 });
  expect(readSemanticProposalResults(child, fixture.childRoot, cap)[0]?.status).toBe("interpreted");
  expect(() => readSemanticProposalResults(changed, fixture.childRoot, cap)).toThrow(/wire identity/u);
});

it("excludes the selected historical parent shard, raw and ledger aliases from evaluator output", async () => {
  const fixture = await retainedFixture(), child = fixture.child();
  const { parentRoot, line, workset, root } = fixture;
  const shard = semanticProposalShardPath(parentRoot, line.key);
  const raw = providerRawAttemptPath(parentRoot, line.key, 1);
  const ledger = ledgerPath(parentRoot, semanticProposalLookup(workset, line, cap).attempt_lineage_digest!);
  const shardAlias = join(root, "physical-shard"), rawAlias = join(root, "physical-raw"), ledgerAlias = join(root, "physical-ledger.json");
  renameSync(dirname(shard), shardAlias); symlinkSync(shardAlias, dirname(shard), "dir");
  renameSync(dirname(raw), rawAlias); symlinkSync(rawAlias, dirname(raw), "dir");
  renameSync(ledger, ledgerAlias); symlinkSync(ledgerAlias, ledger);
  // Inventory is independent of successful admission, so malformed retained bytes remain protected.
  writeFileSync(shard, "{invalid");
  const paths = semanticProposalCacheInputPaths(child, fixture.childRoot, cap);
  expect(paths).toEqual(expect.arrayContaining([parentRoot, shard, raw, ledger]));
  expect(paths).not.toContain(semanticProposalShardPath(parentRoot, materializeSemanticProposalLines(workset, cap)[0]!.key));
  for (const alias of [shardAlias, rawAlias, ledgerAlias]) {
    expect(() => admitEvaluatorOutputRoot(alias, paths)).toThrow(/separate from producer and input roots/u);
  }
  expect(() => prepareSemanticProposal(child, fixture.childRoot, cap, 1)).toThrow(/bounded regular extraction attempt ledger/u);
});

it.each([
  ["model", "different-model"], ["request_profile", "gemini-2.5-nonthinking-v1"],
  ["provider_url", "http://127.0.0.1:10"], ["max_output_tokens", cap + 1],
  ["key", "a".repeat(64)], ["request_digest", "b".repeat(64)], ["system_prompt", "Not the retained guidance."]
] as const)("rejects a changed retained %s", async (field, value) => {
  const fixture = await retainedFixture();
  expect(() => fixture.prepare({ retainedParent: { ...fixture.retained, [field]: value } }))
    .toThrow(/changed model, profile, route or output cap|wire identity/u);
});

it("rejects changed canonical query and response schema", async () => {
  const fixture = await retainedFixture();
  expect(() => fixture.prepare({ workset: { ...fixture.workset, items: [{ ...queryItem, original_query: "Who sent the sample to Alice?" }] } }))
    .toThrow(/unchanged request, schema or wire identity/u);
  const schemaFixture = await retainedFixture("stop", true);
  expect(() => schemaFixture.prepare()).toThrow(/unchanged request, schema or wire identity/u);
});

it.each(["shard", "raw", "ledger", "raw-mismatch"] as const)("rejects missing or mismatched physical parent: %s", async part => {
  const fixture = await retainedFixture(), child = fixture.child();
  const { parentRoot, line, workset } = fixture;
  const rawPath = providerRawAttemptPath(parentRoot, line.key, 1);
  if (part === "raw-mismatch") {
    const raw = JSON.parse(readFileSync(rawPath, "utf8")) as Record<string, unknown>;
    writeFileSync(rawPath, JSON.stringify({ ...raw, request_digest: "a".repeat(64) }));
  } else {
    rmSync(part === "shard" ? semanticProposalShardPath(parentRoot, line.key) : part === "raw" ? rawPath :
      ledgerPath(parentRoot, semanticProposalLookup(workset, line, cap).attempt_lineage_digest!));
  }
  expect(() => fixture.prepare()).toThrow();
  expect(() => prepareSemanticProposal(child, fixture.childRoot, cap, 1)).toThrow();
});

it("refuses incomplete retained output and a missing parent root", async () => {
  const fixture = await retainedFixture("length");
  expect(() => fixture.prepare()).toThrow(/complete physical parent/u);
  expect(() => fixture.prepare({ parentCacheRoot: join(fixture.root, "absent") })).toThrow(/complete physical parent/u);
});

it("rejects malformed, unrevised and unsupported-role retained references", async () => {
  const fixture = await retainedFixture(), revision = fixture.prepare();
  const item = { ...queryItem, revision, retained_parent: fixture.retained };
  expect(() => materializeSemanticProposalLines({ ...fixture.workset,
    items: [{ ...item, retained_parent: { ...fixture.retained, key: "invalid" } }] }, cap)).toThrow();
  expect(() => materializeSemanticProposalLines({ ...fixture.workset,
    items: [{ ...queryItem, retained_parent: fixture.retained }] }, cap)).toThrow(/requires a revision/u);
  expect(() => resolveSemanticProposalRevisionParent({ ...fixture.workset, kind: "semantic_correspondence" }, item, cap))
    .toThrow(/native chat query profile/u);
  expect(() => resolveSemanticProposalRevisionParent({ ...fixture.workset, request_profile: "gemini-3.1-minimal-v1" }, item, cap))
    .toThrow(/native chat query profile/u);
  expect(() => materializeSemanticProposalLines({ ...fixture.workset, kind: "semantic_correspondence", items: [item] }, cap)).toThrow();
});
