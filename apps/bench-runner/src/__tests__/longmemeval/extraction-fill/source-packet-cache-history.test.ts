import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOfficialApiSourcePacketRequest, completeEmptyOfficialApiSourcePacket,
  OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { inspectCachedSourcePacket } from "../../../runs/extraction/cache/source-packet-artifact.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { writeCachedExtraction, cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeExtractionRawJsonSha256 } from "../../../runs/extraction/content-closure.js";
import { readExtractionCacheManifest, writeExtractionCacheManifest, extractionAdmissionGenerationSha256 } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import { assertCurrentConversationGeneration } from "../../../runs/extraction/request-artifact.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";

const MODEL = "recorded-history", PROFILE = { contract: "source-interpretation-profile-v1" as const,
  description: "Historical use relations", predicates: [{ symbol: "uses", governing_roles: [], meaning: "An agent uses a theme." }],
  roles: [{ symbol: "agent", meaning: "Actor" }, { symbol: "theme", meaning: "Object" }] };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

function retainedEmpty() {
  const cacheRoot = mkdtempSync(join(tmpdir(), "alaya-packet-history-")); directories.push(cacheRoot);
  writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, systemPrompt: OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT });
  writeExtractionCacheManifest(cacheRoot, { ...readExtractionCacheManifest(cacheRoot)!, source_interpretation_profile: PROFILE });
  const manifest = readExtractionCacheManifest(cacheRoot)!;
  const request = buildOfficialApiSourcePacketRequest("", [], PROFILE), userPrompt = JSON.stringify(request);
  const key = computeCacheKey(MODEL, "provider-default-v1", OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, userPrompt);
  const { rawJson } = completeEmptyOfficialApiSourcePacket(request, { sourceCorpus: "", artifactKey: key, producerId: "recorded-history" });
  const line = { key, unitKeys: [], requestSha256: createHash("sha256").update(userPrompt).digest("hex"),
    systemPrompt: OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, userPrompt };
  writeCachedExtraction(cacheRoot, key, { model: MODEL, request_profile: "provider-default-v1", cache_key: key,
    raw_json: rawJson, extracted_at: "2026-01-01T00:00:00.000Z",
    admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(manifest), request_key: key,
      raw_json_sha256: computeExtractionRawJsonSha256(rawJson) }, source_packet: {
      contract: "source-interpretation-cache-v1", source_binding: "unbound", kind: "deterministic_empty",
      completion: "empty", source_corpus: "", producer_id: "recorded-history", line } });
  return { cacheRoot, key };
}

describe("retained passive packet inspection without new admission", () => {
  it("reads the old valid-empty meaning without relabeling or rewriting its bytes", () => {
    const { cacheRoot, key } = retainedEmpty(), before = readFileSync(cacheFilePath(cacheRoot, key));
    const inspected = inspectCachedSourcePacket(cacheRoot, key, MODEL, "provider-default-v1");
    expect(inspected, JSON.stringify(inspected)).toMatchObject({
      status: "hit", artifactKind: "source_interpretation", deterministicEmpty: true, admitted: { status: "empty" } });
    expect(readFileSync(cacheFilePath(cacheRoot, key))).toEqual(before);
  });

  it("rejects current fill of a historical generation before dataset/provider work and preserves the root", async () => {
    const { cacheRoot, key } = retainedEmpty(), before = readFileSync(cacheFilePath(cacheRoot, key));
    await expect(runExtractionFill({ cacheRoot, variant: "longmemeval_s", sourceInterpretationProfile: PROFILE }))
      .rejects.toThrow("retired passive generation");
    expect(readFileSync(cacheFilePath(cacheRoot, key))).toEqual(before);
  });

  it.each([undefined, "prepare", "submit", "import", "resume"])("does not authorize retired output through %s", operation => {
    expect(() => assertCurrentConversationGeneration({ sourcePacking: "reference-eight" }, operation)).toThrow("retired");
  });

  it.each(["status", "cancel", "recover"])("retains %s handling of acknowledged jobs without generation or admission", operation => {
    expect(() => assertCurrentConversationGeneration({ sourcePacking: "reference-eight" }, operation)).not.toThrow();
  });
});
