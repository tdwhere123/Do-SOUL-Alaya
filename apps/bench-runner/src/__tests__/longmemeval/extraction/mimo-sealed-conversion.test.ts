import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  parseOfficialApiSignals,
  planOfficialApiSemanticWorkset,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { promptSha256 } from "../../../runs/extraction/cache/semantic-artifact/admit.js";
import { convertLegacyExtractionShard } from "../../../runs/extraction/cache/semantic-artifact/legacy-convert.js";
import {
  admitSemanticArtifact,
  inspectSemanticArtifact,
  persistRawArtifact,
  readPersistedRawArtifact,
  recordedSourceBindings,
  reserveSemanticArtifact
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import { fulfillAssertionCapability } from "../../../runs/extraction/cache/semantic-artifact/fulfill.js";
import { shadowLazyF3Fulfillment } from "../../../runs/extraction/cache/semantic-artifact/lazy-f3-shadow.js";
import { buildSnapshotExtractionSummary } from "../../../runs/snapshot/extraction-authority.js";
import type { CachedExtractionEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import type { SemanticFillTask } from "../../../runs/extraction/fill/semantic-fill-executor.js";
import type { ExtractionCacheManifestV3 } from "../../../runs/extraction/cache/extraction-cache-manifest.js";

const FIXTURES = dirname(fileURLToPath(import.meta.url)) + "/fixtures";
const DATASET_REVISION =
  "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
const CONTRACT = "alaya.assertion_semantic_identity.v1";
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

describe("sealed MiMo shard conversion", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mimo-convert-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("converts a locator-bearing shard with minted identity and replays raw bytes", async () => {
    const fixture = loadTurn(SINGLE_KEY);
    const entry = JSON.parse(await readFile(join(FIXTURES, `${SINGLE_KEY}.shard.json`), "utf8")) as CachedExtractionEntry;
    const bindings = planOfficialApiSemanticWorkset(
      fixture.turn.turnContent,
      fixture.turn.turnMessages,
      DATASET_REVISION
    ).units.filter((unit) => fixture.request.source_assertions.some(
      (assertion) => assertion.assertion_id === unit.assertionId
    )).map((unit) => unit.binding);
    expect(bindings[0]?.semanticKey).toMatch(/^[a-f0-9]{64}$/u);
    const drafts = parseOfficialApiSignals(entry.raw_json);
    expect(drafts.length).toBeGreaterThan(0);
    const report = convertLegacyExtractionShard({
      entry,
      request: fixture.request,
      sourceBindings: bindings,
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: promptSha256(OFFICIAL_API_SYSTEM_PROMPT)
    });
    expect(report.converted.length).toBeGreaterThan(0);
    expect(report.converted[0]?.admission_state).toBe("provider_backed");
    expect(report.converted[0]?.semantic_key).toBe(bindings[0]?.semanticKey);
    const digest = persistRawArtifact(root, entry.raw_json);
    expect(readPersistedRawArtifact(root, digest)).toBe(entry.raw_json);
    const artifact = report.converted[0]!;
    const token = reserveSemanticArtifact(root, artifact.semantic_key, artifact.capability);
    admitSemanticArtifact({ root, artifact, reservationToken: token });
    expect(inspectSemanticArtifact(root, artifact.semantic_key, artifact.capability).status)
      .toBe("provider_backed");
    expect(recordedSourceBindings(root, artifact.semantic_key, artifact.capability).length)
      .toBeGreaterThan(0);
    expect(parseOfficialApiSignals(readPersistedRawArtifact(root, digest)).length).toBe(drafts.length);
  });

  it("does not mint a duplicate assertion_id from a sealed multi-signal shard", async () => {
    const fixture = loadTurn(MULTI_KEY);
    const entry = JSON.parse(await readFile(join(FIXTURES, `${MULTI_KEY}.shard.json`), "utf8")) as CachedExtractionEntry;
    const bindings = planOfficialApiSemanticWorkset(
      fixture.turn.turnContent,
      fixture.turn.turnMessages,
      DATASET_REVISION
    ).units.map((unit) => unit.binding);
    const report = convertLegacyExtractionShard({
      entry,
      request: fixture.request,
      sourceBindings: bindings,
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      expectedPromptSha256: promptSha256(OFFICIAL_API_SYSTEM_PROMPT)
    });
    expect(report.converted).toEqual([]);
    expect(report.unresolved[0]?.reason).toMatch(/incomplete inspection/u);
  });

  it("admits the same sealed raw through fill and warms Lazy F3 to zero calls", async () => {
    const fixture = loadTurn(SINGLE_KEY);
    const entry = JSON.parse(await readFile(join(FIXTURES, `${SINGLE_KEY}.shard.json`), "utf8")) as CachedExtractionEntry;
    const binding = planOfficialApiSemanticWorkset(
      fixture.turn.turnContent,
      fixture.turn.turnMessages,
      DATASET_REVISION
    ).units.find((item) => item.assertionId === fixture.request.source_assertions[0]!.assertion_id)?.binding;
    if (binding === undefined) throw new Error("missing minted binding");
    const task: SemanticFillTask = {
      semanticKey: binding.semanticKey,
      capability: "official_api_signals:v1",
      semanticContract: CONTRACT,
      modelFamily: "mimo-v2.5",
      modelId: "mimo-v2.5",
      requestProfile: "mimo-v2.5-nonthinking-v1",
      providerUrlSha256: "1d0c8dae4013f0dd0883ac7692d61535aa7cdbad5eab0302c57fa1d0f07fe77a",
      assertionId: binding.locator.assertion_id,
      text: fixture.request.source_assertions[0]!.text,
      binding
    };
    const envelope = { mode: "offline-only" as const, maxCalls: 2, maxFailures: 2 };
    const shadow = shadowLazyF3Fulfillment({
      root,
      demand: [task],
      envelope,
      transport: { complete: () => ({ kind: "raw", rawJson: entry.raw_json }) }
    });
    expect(shadow.revealed[0]?.state).toBe("materialized-now");
    expect(shadow.warm[0]?.state).toBe("cache-hit");
    expect(shadow.warmCalls).toBe(0);
    expect(shadow.coldCalls).toBe(1);
    const temporal = fulfillAssertionCapability({
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
