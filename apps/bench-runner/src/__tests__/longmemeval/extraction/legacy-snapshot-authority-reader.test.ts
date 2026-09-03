import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  buildOfficialApiExtractionRequests,
  planOfficialApiSemanticWorkset,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { computeCacheKey } from
  "../../../runs/compile-seed/cache/cache-key.js";
import type { CachedExtractionEntry } from
  "../../../runs/compile-seed/cache/cache-shard.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  extractionCacheManifestPath,
  writeExtractionCacheManifest
} from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import {
  buildExtractionContentClosureIndex,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from "../../../runs/extraction/content-closure.js";
import { convertLegacyExtractionShard } from
  "../../../runs/extraction/cache/semantic-artifact/legacy-convert.js";
import {
  parseCapturedLegacyExtractionEntry,
  readVerifiedLegacyExtractionEntry
} from "../../../runs/extraction/cache/semantic-artifact/legacy-sealed-entry.js";
import {
  admitSemanticArtifact,
  inspectSemanticArtifact,
  persistRawArtifact,
  releaseSemanticArtifactReservation,
  reserveSemanticArtifact
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
  loadGlobalExtractionAuthority
} from "../../../runs/provenance/contract/extraction-authority-reference.js";
import {
  captureSnapshotExtractionAuthority,
  renderSnapshotExtractionAuthority
} from "../../../runs/snapshot/extraction-authority.js";

const DATASET_REVISION = "55".repeat(32);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

async function fixture(options: Readonly<{
  matchedText?: string;
  finishReason?: string | null;
  transportModel?: string;
  transportProviderUrlSha256?: string;
  omitResponseMetadata?: boolean;
  omitTransport?: boolean;
  omitCompletionWitness?: boolean;
  rawJson?: string;
}> = {}) {
  const cacheRoot = await mkdtemp(join(tmpdir(), "legacy-authority-cache-"));
  const authorityRoot = await mkdtemp(join(tmpdir(), "legacy-authority-pin-"));
  roots.push(cacheRoot, authorityRoot);
  const text = "I moved to Berlin.";
  const request = buildOfficialApiExtractionRequests(text, [
    { role: "user", content: text }
  ])[0]!;
  const unit = planOfficialApiSemanticWorkset(text, [
    { role: "user", content: text }
  ], DATASET_REVISION).units[0]!;
  const cacheKey = computeCacheKey(
    "mimo-v2.5",
    "mimo-v2.5-nonthinking-v1",
    OFFICIAL_API_SYSTEM_PROMPT,
    stringifyOfficialApiExtractionRequest(request)
  );
  const rawJson = options.rawJson ?? JSON.stringify({ signals: [{
    object_kind: "fact",
    confidence: 0.9,
    matched_text: options.matchedText ??
      request.source_assertions[0]!.text.replace(/^(?:User|Assistant): /u, ""),
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: request.source_assertions[0]!.assertion_id
    }
  }] });
  const entry: CachedExtractionEntry = {
    model: "mimo-v2.5",
    request_profile: "mimo-v2.5-nonthinking-v1",
    cache_key: cacheKey,
    raw_json: rawJson,
    extracted_at: "2026-08-23T10:07:08.564Z",
    ...(options.omitTransport === true ? {} : {
      transport_provenance: {
        provider_url_sha256: `sha256:${options.transportProviderUrlSha256 ?? createHash("sha256")
          .update("https://provider.invalid/v1", "utf8").digest("hex")}`,
        model: options.transportModel ?? "mimo-v2.5"
      }
    }),
    ...(options.omitResponseMetadata === true ? {} : {
      response_metadata: {
        finish_reason: options.finishReason === undefined ? "stop" : options.finishReason,
        completion_contract_version: 1,
        ...(options.omitCompletionWitness === true ? {} : {
          completion_witness: "done_sentinel"
        })
      }
    })
  };
  const shardPath = join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`);
  await mkdir(dirname(shardPath), { recursive: true });
  await writeFile(shardPath, JSON.stringify(entry), "utf8");
  const closure = {
    cacheKey,
    model: entry.model,
    requestProfile: entry.request_profile,
    ...inspectExtractionRawJson(entry.raw_json)
  };
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: 3,
    extraction_model: entry.model,
    model_family: "mimo-v2.5",
    request_profile: entry.request_profile,
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "sealed-fixture",
    dataset_revision: DATASET_REVISION,
    requested_turns: 1,
    cached_turns: 1,
    coverage: 1,
    storage: "git-tracked",
    built_at: entry.extracted_at,
    builder: "fixture",
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    expected_turns: 1,
    expected_key_set_sha256: computeExtractionKeySetSha256([cacheKey]),
    content_closure_sha256: computeExtractionContentClosureSha256([closure]),
    content_closure_index: buildExtractionContentClosureIndex([closure])
  });
  const captured = captureSnapshotExtractionAuthority(cacheRoot);
  await writeFile(
    join(authorityRoot, LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME),
    renderSnapshotExtractionAuthority(captured.authority)
  );
  const authority = await loadGlobalExtractionAuthority(authorityRoot);
  if (authority === null) throw new Error("fixture authority did not load");
  return { cacheRoot, authorityRoot, authority, cacheKey, shardPath, entry, request, unit };
}

function readFromAuthority(input: Awaited<ReturnType<typeof fixture>>) {
  return readVerifiedLegacyExtractionEntry({
    root: input.cacheRoot,
    cacheKey: input.cacheKey,
    authority: input.authority
  });
}

describe("legacy conversion snapshot authority reader", () => {
  it("reads a legal fixture only through a snapshot authority pin outside the cache root", async () => {
    const value = await fixture();
    const handle = readFromAuthority(value);

    expect(parseCapturedLegacyExtractionEntry(handle)).toEqual(value.entry);
  });

  it("rejects manifest, shard identity, and raw bytes changed after the external pin", async () => {
    const manifest = await fixture();
    await writeFile(extractionCacheManifestPath(manifest.cacheRoot), "{}\n", "utf8");
    expect(() => readFromAuthority(manifest)).toThrow(/manifest.*(?:authority|digest)|authority.*manifest/iu);

    const shard = await fixture();
    await writeFile(shard.shardPath, JSON.stringify({ ...shard.entry, model: "foreign-model" }), "utf8");
    expect(() => readFromAuthority(shard)).toThrow(/shard|closure|authority/iu);

    const raw = await fixture();
    await writeFile(raw.shardPath, JSON.stringify({
      ...raw.entry,
      raw_json: raw.entry.raw_json.replace("Berlin", "Paris")
    }), "utf8");
    expect(() => readFromAuthority(raw)).toThrow(/raw|closure|authority/iu);
  });

  it("rejects truncated completion and transport/model mismatch", async () => {
    const truncated = await fixture({ finishReason: "length" });
    expect(() => readFromAuthority(truncated)).toThrow(/finish_reason=length|not complete/iu);

    const transportModel = await fixture({ transportModel: "foreign-model" });
    expect(() => readFromAuthority(transportModel)).toThrow(/transport.*model.*mismatch/iu);

    const transportProvider = await fixture({ transportProviderUrlSha256: "aa".repeat(32) });
    expect(() => readFromAuthority(transportProvider)).toThrow(/transport.*provider.*mismatch/iu);
  });

  it("cannot convert as verified when snapshot authority lacks shard completion or transport metadata", async () => {
    const missingMetadata = await fixture({ omitResponseMetadata: true });
    expect(() => readFromAuthority(missingMetadata)).toThrow(/response_metadata|completion/iu);

    const missingWitness = await fixture({ omitCompletionWitness: true });
    expect(() => readFromAuthority(missingWitness)).toThrow(/response_metadata|completion/iu);

    const missingTransport = await fixture({ omitTransport: true });
    expect(() => readFromAuthority(missingTransport)).toThrow(/transport/iu);
  });

  it("rejects finish_reason mutation after wrap instead of re-wrapping as verified", async () => {
    const captured = await fixture();
    const handle = readFromAuthority(captured);
    const parsed = parseCapturedLegacyExtractionEntry(handle);
    expect(() => {
      (parsed.response_metadata as { finish_reason: string | null }).finish_reason = "length";
    }).toThrow(/read only|frozen|cannot/iu);
    const sealedReport = convertLegacyExtractionShard({
      sealedEntry: handle,
      request: captured.request,
      sourceUnits: [captured.unit],
      semanticContract: captured.unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(sealedReport.converted).toHaveLength(1);
    expect(sealedReport.unresolved).toEqual([]);

    await writeFile(captured.shardPath, JSON.stringify({
      ...captured.entry,
      response_metadata: { ...captured.entry.response_metadata, finish_reason: "length" }
    }), "utf8");
    expect(() => parseCapturedLegacyExtractionEntry(handle)).toThrow(/changed after bounded capture/iu);
    const mutatedReport = convertLegacyExtractionShard({
      sealedEntry: handle,
      request: captured.request,
      sourceUnits: [captured.unit],
      semanticContract: captured.unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(mutatedReport.converted).toEqual([]);
    expect(mutatedReport.unresolved[0]?.reason).toMatch(/changed after bounded capture/iu);

    const stillComplete = await fixture();
    const first = readFromAuthority(stillComplete);
    expect(convertLegacyExtractionShard({
      sealedEntry: first,
      request: stillComplete.request,
      sourceUnits: [stillComplete.unit],
      semanticContract: stillComplete.unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    }).converted).toHaveLength(1);
    await writeFile(stillComplete.shardPath, JSON.stringify({
      ...stillComplete.entry,
      response_metadata: { ...stillComplete.entry.response_metadata, finish_reason: null }
    }), "utf8");
    expect(() => readFromAuthority(stillComplete)).toThrow(/completion metadata changed after snapshot seal/iu);
  });

  it("keeps empty signals without exhaustive proof unresolved", async () => {
    const empty = await fixture({ rawJson: "{\"signals\":[]}" });
    const report = convertLegacyExtractionShard({
      sealedEntry: readFromAuthority(empty),
      request: empty.request,
      sourceUnits: [empty.unit],
      semanticContract: empty.unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(report.converted).toEqual([]);
    expect(report.unresolved[0]?.reason).toMatch(/no independent assertion-level completion witness/iu);
  });

  it("keeps wrong matched_text and locator tampering unresolved", async () => {
    const wrongQuote = await fixture({ matchedText: "Berlin" });
    const wrongQuoteReport = convertLegacyExtractionShard({
      sealedEntry: readFromAuthority(wrongQuote),
      request: wrongQuote.request,
      sourceUnits: [wrongQuote.unit],
      semanticContract: wrongQuote.unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(wrongQuoteReport.converted).toEqual([]);
    expect(wrongQuoteReport.unresolved.map((item) => item.reason).join("\n"))
      .toMatch(/grounding|matched_text|exact source/iu);

    const value = await fixture();
    const handle = readFromAuthority(value);
    const report = convertLegacyExtractionShard({
      sealedEntry: handle,
      request: value.request,
      sourceUnits: [{
        ...value.unit,
        binding: {
          ...value.unit.binding,
          locator: { ...value.unit.binding.locator, assertion_id: 999 }
        }
      }],
      semanticContract: value.unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });

    expect(report.converted).toEqual([]);
    expect(report.unresolved[0]?.reason).toMatch(/locator|binding/iu);
  });

  it("rejects a tampered snapshot authority and a shard changed after capture", async () => {
    const snapshot = await fixture();
    await writeFile(
      join(snapshot.authorityRoot, LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME),
      `${JSON.stringify({ ...snapshot.authority.authority, coverage: 0.5 })}\n`,
      "utf8"
    );
    await expect(loadGlobalExtractionAuthority(snapshot.authorityRoot))
      .rejects.toThrow(/snapshot extraction authority is invalid/iu);

    const captured = await fixture();
    const handle = readFromAuthority(captured);
    await writeFile(captured.shardPath, JSON.stringify({
      ...captured.entry,
      response_metadata: { ...captured.entry.response_metadata, finish_reason: "length" }
    }), "utf8");
    expect(() => parseCapturedLegacyExtractionEntry(handle)).toThrow(/changed after bounded capture/iu);
  });

  it("persists authority-bound conversion into a new semantic root and rejects plain data", async () => {
    const value = await fixture();
    const sealedEntry = readFromAuthority(value);
    const report = convertLegacyExtractionShard({
      sealedEntry,
      request: value.request,
      sourceUnits: [value.unit],
      semanticContract: value.unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(report.converted).toHaveLength(1);
    expect(report.unresolved).toEqual([]);

    const targetRoot = await mkdtemp(join(tmpdir(), "legacy-semantic-target-"));
    const plainRoot = await mkdtemp(join(tmpdir(), "legacy-semantic-plain-"));
    roots.push(targetRoot, plainRoot);
    expect(persistRawArtifact(targetRoot, value.entry.raw_json)).toBe(report.raw_json_sha256);
    const expectedIdentity = {
      ...value.unit,
      capability: "official_api_signals:v1",
      semanticContract: value.unit.semanticIdentity.contractId,
      modelFamily: sealedEntry.modelFamily,
      modelId: sealedEntry.model,
      transportModelId: sealedEntry.transportModel,
      requestProfile: sealedEntry.requestProfile,
      providerUrlSha256: sealedEntry.providerUrlSha256
    };
    const token = reserveSemanticArtifact(
      targetRoot, value.unit.semanticKey, "official_api_signals:v1"
    );
    admitSemanticArtifact({
      root: targetRoot,
      admission: report.converted[0]!,
      reservationToken: token,
      expectedIdentity
    });
    const persisted = inspectSemanticArtifact(
      targetRoot, value.unit.semanticKey, "official_api_signals:v1"
    );
    expect(persisted.status).toBe("provider_backed");

    persistRawArtifact(plainRoot, value.entry.raw_json);
    const plainToken = reserveSemanticArtifact(
      plainRoot, value.unit.semanticKey, "official_api_signals:v1"
    );
    expect(() => admitSemanticArtifact({
      root: plainRoot,
      admission: persisted.artifact as never,
      reservationToken: plainToken,
      expectedIdentity
    })).toThrow(/verified admission handle/iu);
    releaseSemanticArtifactReservation(
      plainRoot, value.unit.semanticKey, "official_api_signals:v1", plainToken
    );
  });

  it("remains unavailable when no external snapshot authority is supplied", async () => {
    const value = await fixture();
    expect(() => readVerifiedLegacyExtractionEntry({
      root: value.cacheRoot,
      cacheKey: value.cacheKey
    } as never)).toThrow(/unavailable|authority|trust root/iu);
  });

  it("converts the sealed MiMo fixture when completion and transport metadata are complete", async () => {
    const cacheKey = "0c297b4cd1547986994b6f4acd44b7bfa1e40d5eba9c803e2c53cba93bafc295";
    const datasetRevision =
      "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
    const fixtures = dirname(fileURLToPath(import.meta.url)) + "/fixtures";
    const turns = JSON.parse(await readFile(join(fixtures, "mimo-legacy-turns.json"), "utf8")) as
      readonly {
        readonly cache_key: string;
        readonly turn: {
          readonly turnContent: string;
          readonly turnMessages: readonly { role: "user" | "assistant"; content: string }[];
        };
        readonly request: OfficialApiExtractionRequest;
      }[];
    const turn = turns.find((item) => item.cache_key === cacheKey);
    if (turn === undefined) throw new Error("missing sealed MiMo turn fixture");
    const cacheRoot = await mkdtemp(join(tmpdir(), "mimo-sealed-cache-"));
    const authorityRoot = await mkdtemp(join(tmpdir(), "mimo-sealed-pin-"));
    roots.push(cacheRoot, authorityRoot);
    const providerUrl = "https://provider.invalid/v1";
    const entry = JSON.parse(await readFile(join(fixtures, `${cacheKey}.shard.json`), "utf8")) as
      CachedExtractionEntry;
    const bound: CachedExtractionEntry = {
      ...entry,
      transport_provenance: {
        provider_url_sha256: `sha256:${createHash("sha256").update(providerUrl, "utf8").digest("hex")}`,
        model: entry.transport_provenance?.model ?? entry.model
      }
    };
    const shardPath = join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`);
    await mkdir(dirname(shardPath), { recursive: true });
    await writeFile(shardPath, JSON.stringify(bound), "utf8");
    const closure = {
      cacheKey,
      model: bound.model,
      requestProfile: bound.request_profile,
      ...inspectExtractionRawJson(entry.raw_json)
    };
    writeExtractionCacheManifest(cacheRoot, {
      schema_version: 3,
      extraction_model: entry.model,
      model_family: "mimo-v2.5",
      request_profile: entry.request_profile,
      provider_url: providerUrl,
      system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "sealed-mimo-fixture",
      dataset_revision: datasetRevision,
      requested_turns: 1,
      cached_turns: 1,
      coverage: 1,
      storage: "git-tracked",
      built_at: entry.extracted_at,
      builder: "fixture",
      fill_status: "complete",
      window_offset: 0,
      window_limit: 1,
      expected_turns: 1,
      expected_key_set_sha256: computeExtractionKeySetSha256([cacheKey]),
      content_closure_sha256: computeExtractionContentClosureSha256([closure]),
      content_closure_index: buildExtractionContentClosureIndex([closure])
    });
    const captured = captureSnapshotExtractionAuthority(cacheRoot);
    await writeFile(
      join(authorityRoot, LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME),
      renderSnapshotExtractionAuthority(captured.authority)
    );
    const authority = await loadGlobalExtractionAuthority(authorityRoot);
    if (authority === null) throw new Error("fixture authority did not load");
    const unit = planOfficialApiSemanticWorkset(
      turn.turn.turnContent,
      turn.turn.turnMessages,
      datasetRevision
    ).units.find((item) => item.assertionId === turn.request.source_assertions[0]!.assertion_id);
    if (unit === undefined) throw new Error("missing minted binding");
    const report = convertLegacyExtractionShard({
      sealedEntry: readVerifiedLegacyExtractionEntry({
        root: cacheRoot, cacheKey, authority
      }),
      request: turn.request,
      sourceUnits: [unit],
      semanticContract: unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(report.converted).toHaveLength(1);
    expect(report.converted[0]?.state).toBe("provider_backed");
    expect(report.unresolved).toEqual([]);
  });
});
