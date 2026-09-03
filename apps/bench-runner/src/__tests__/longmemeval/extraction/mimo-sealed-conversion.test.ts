import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  planOfficialApiSemanticWorkset,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { convertLegacyExtractionShard } from
  "../../../runs/extraction/cache/semantic-artifact/legacy-convert.js";
import { readVerifiedLegacyExtractionEntry } from
  "../../../runs/extraction/cache/semantic-artifact/legacy-sealed-entry.js";
import { fulfillAssertionCapability } from "../../../runs/extraction/cache/semantic-artifact/fulfill.js";
import { shadowLazyF3Fulfillment } from "../../../runs/extraction/cache/semantic-artifact/lazy-f3-shadow.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import {
  TOKEN_AWARE_POLICY,
  semanticFixtureSourceAuthority
} from "./semantic-artifact-fixture.js";
import {
  captureSnapshotExtractionAuthority,
  renderSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../../runs/snapshot/extraction-authority.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  writeExtractionCacheManifest
} from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import {
  buildExtractionContentClosureIndex,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from "../../../runs/extraction/content-closure.js";
import {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
  loadGlobalExtractionAuthority
} from "../../../runs/provenance/contract/extraction-authority-reference.js";
import type { CachedExtractionEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import type { SemanticFillTask } from "../../../runs/extraction/fill/semantic-fill-executor.js";
import type { ExtractionCacheManifestV3 } from "../../../runs/extraction/cache/extraction-cache-manifest.js";

const FIXTURES = dirname(fileURLToPath(import.meta.url)) + "/fixtures";
const DATASET_REVISION =
  "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
const SINGLE_KEY = "0c297b4cd1547986994b6f4acd44b7bfa1e40d5eba9c803e2c53cba93bafc295";
const MULTI_KEY = "0cf56b73a55320505f980064c64b0d51afe2143754bd6340199703d9f4e5e673";

function loadTurn(cacheKey: string) {
  const turns = JSON.parse(readFileSync(join(FIXTURES, "mimo-legacy-turns.json"), "utf8")) as
    readonly {
      readonly cache_key: string;
      readonly turn: { readonly turnContent: string; readonly turnMessages: readonly { role: "user" | "assistant"; content: string }[] };
      readonly request: OfficialApiExtractionRequest;
    }[];
  const found = turns.find((item) => item.cache_key === cacheKey);
  if (found === undefined) throw new Error(`missing turn fixture ${cacheKey}`);
  return found;
}

async function installSealedMimoShard(
  cacheKey: string,
  roots: string[]
) {
  const cacheRoot = await mkdtemp(join(tmpdir(), "mimo-legacy-cache-"));
  const authorityRoot = await mkdtemp(join(tmpdir(), "mimo-legacy-pin-"));
  roots.push(cacheRoot, authorityRoot);
  const providerUrl = "https://provider.invalid/v1";
  const entry = JSON.parse(await readFile(join(FIXTURES, `${cacheKey}.shard.json`), "utf8")) as
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
  return { cacheRoot, authority };
}

describe("sealed MiMo shard conversion", () => {
  let root: string;
  const roots: string[] = [];
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mimo-convert-")); });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true })));
  });

  it("rejects locator-bearing legacy conversion without opaque external authority", () => {
    expect(() => readVerifiedLegacyExtractionEntry({
      root, cacheKey: SINGLE_KEY
    } as never)).toThrow(/loaded extraction authority/u);
  });

  it("rejects incomplete legacy entries without opaque external authority", () => {
    expect(() => readVerifiedLegacyExtractionEntry({
      root, cacheKey: MULTI_KEY
    } as never)).toThrow(/loaded extraction authority/u);
  });

  it("converts a sealed MiMo fixture when shard completion and transport metadata are complete", async () => {
    const fixture = loadTurn(SINGLE_KEY);
    const installed = await installSealedMimoShard(SINGLE_KEY, roots);
    const unit = planOfficialApiSemanticWorkset(
      fixture.turn.turnContent,
      fixture.turn.turnMessages,
      DATASET_REVISION
    ).units.find((item) => item.assertionId === fixture.request.source_assertions[0]!.assertion_id);
    if (unit === undefined) throw new Error("missing minted binding");
    const report = convertLegacyExtractionShard({
      sealedEntry: readVerifiedLegacyExtractionEntry({
        root: installed.cacheRoot,
        cacheKey: SINGLE_KEY,
        authority: installed.authority
      }),
      request: fixture.request,
      sourceUnits: [unit],
      semanticContract: unit.semanticIdentity.contractId,
      expectedSystemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(report.converted).toHaveLength(1);
    expect(report.converted[0]?.state).toBe("provider_backed");
    expect(report.unresolved).toEqual([]);
  });

  it("admits the same sealed raw through fill and warms Lazy F3 to zero calls", async () => {
    const fixture = loadTurn(SINGLE_KEY);
    const entry = JSON.parse(await readFile(join(FIXTURES, `${SINGLE_KEY}.shard.json`), "utf8")) as CachedExtractionEntry;
    const unit = planOfficialApiSemanticWorkset(
      fixture.turn.turnContent,
      fixture.turn.turnMessages,
      DATASET_REVISION
    ).units.find((item) => item.assertionId === fixture.request.source_assertions[0]!.assertion_id);
    if (unit === undefined) throw new Error("missing minted binding");
    const fixtureAuthority = semanticFixtureSourceAuthority(unit.sourceCorpus);
    const task: SemanticFillTask = {
      ...unit,
      capability: "official_api_signals:v1",
      semanticContract: unit.semanticIdentity.contractId,
      modelFamily: "mimo-v2.5",
      modelId: "mimo-v2.5",
      transportModelId: "mimo-v2.5",
      requestProfile: "mimo-v2.5-nonthinking-v1",
      providerUrlSha256: "1d0c8dae4013f0dd0883ac7692d61535aa7cdbad5eab0302c57fa1d0f07fe77a",
      sourceAuthority: {
        ...fixtureAuthority,
        datasetRevision: DATASET_REVISION,
        substrateManifest: {
          ...fixtureAuthority.substrateManifest,
          datasetRevision: DATASET_REVISION
        }
      }
    };
    const envelope = createOfflineSemanticEnvelope({
      maxCalls: 2, maxFailures: 2, transportPolicy: TOKEN_AWARE_POLICY
    });
    const shadow = await shadowLazyF3Fulfillment({
      root,
      demand: [task],
      envelope,
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: entry.raw_json }
      })
    });
    expect(shadow.revealed[0]?.state).toBe("materialized-now");
    expect(shadow.warm[0]?.state).toBe("cache-hit");
    expect(shadow.warmCalls).toBe(0);
    expect(shadow.coldCalls).toBe(1);
    expect((await fulfillAssertionCapability({
      root,
      task: { ...task, providerUrlSha256: "ff".repeat(32) },
      envelope
    })).state).toBe("cache-hit");
    const temporal = await fulfillAssertionCapability({
      root,
      task: { ...task, capability: "temporal_validity:v1" },
      envelope
    });
    expect(temporal.state).toBe("unavailable");
  });
});

describe("snapshot bench mode binding", () => {
  it("keeps complete snapshot compact free of bench-mode identity", () => {
    const manifest = {
      schema_version: 3,
      extraction_model: "mimo-v2.5",
      model_family: "mimo-v2.5",
      request_profile: "mimo-v2.5-nonthinking-v1",
      provider_url: "https://example.invalid/v1",
      system_prompt_sha256: "11".repeat(32),
      cache_key_algo: "sha256(model\\0requestProfile\\0systemPrompt\\0canonicalExtractionRequest)",
      dataset: "longmemeval-s",
      dataset_revision: "rev",
      requested_turns: 1,
      cached_turns: 1,
      coverage: 1,
      fill_status: "complete",
      window_offset: 0,
      window_limit: 1,
      expected_turns: 1,
      expected_key_set_sha256: "22".repeat(32),
      content_closure_sha256: "33".repeat(32),
      storage: "archive",
      built_at: "2026-08-23T00:00:00Z",
      builder: "test"
    } as ExtractionCacheManifestV3;
    const compact = buildSnapshotExtractionSummary(manifest, "44".repeat(32));
    expect("extraction_bench_mode" in compact).toBe(false);
  });
});
