import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceBoundF3Seal } from "@do-soul/alaya-soul";
import {
  ProviderPreflightReplayReceiptSchema,
  verifyProviderPreflightReplayReceipt,
  verifyProviderPreflightReplayReceiptBinding
} from
  "../../../../bench/provider/replay-receipt.js";
import { runProviderPreflightCommand } from
  "../../../../cli/provider-preflight/command.js";
import {
  MIMO,
  createCanonicalReplayManifestBody,
  sealReplayManifest
} from "./complete-mimo-cache.js";

const roots: string[] = [];

function replayReceiptFixture() {
  return {
    schema_version: 2 as const,
    kind: "provider_preflight_replay_receipt" as const,
    provider_port: "absent" as const,
    physical_calls: 0 as const,
    model: MIMO.id,
    profile: MIMO.requestProfile,
    key_count: 1,
    request_manifest_sha256: "a".repeat(64),
    cache_manifest_sha256: "b".repeat(64),
    evidence_prompt_sha256: "c".repeat(64),
    query_prompt_sha256: "d".repeat(64),
    evidence_request_template_sha256: "e".repeat(64),
    query_request_template_sha256: "f".repeat(64)
  };
}

function receiptForManifest(manifest: ReturnType<typeof sealReplayManifest>) {
  const seal = sourceBoundF3Seal();
  return {
    schema_version: 2 as const,
    kind: "provider_preflight_replay_receipt" as const,
    provider_port: "absent" as const,
    physical_calls: 0 as const,
    model: manifest.request.model,
    profile: manifest.request.requestProfile,
    key_count: manifest.request.requestedKeys.length,
    request_manifest_sha256: manifest.request_manifest_sha256,
    cache_manifest_sha256: manifest.cache_authority.manifest_sha256,
    evidence_prompt_sha256: seal.evidence_prompt_sha256,
    query_prompt_sha256: seal.query_prompt_sha256,
    evidence_request_template_sha256: seal.evidence_request_template_sha256,
    query_request_template_sha256: seal.query_request_template_sha256
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider replay receipt", () => {
  it("rejects legacy, minimal, and extra-key evidence shapes", () => {
    const current = replayReceiptFixture();
    expect(ProviderPreflightReplayReceiptSchema.parse(current)).toEqual(current);
    expect(ProviderPreflightReplayReceiptSchema.safeParse({
      ...current,
      schema_version: 1
    }).success).toBe(false);
    expect(ProviderPreflightReplayReceiptSchema.safeParse({
      schema_version: 2,
      kind: "provider_preflight_replay_receipt",
      provider_port: "absent",
      physical_calls: 0
    }).success).toBe(false);
    expect(ProviderPreflightReplayReceiptSchema.safeParse({
      ...current,
      unsealed_note: "accepted by a loose consumer"
    }).success).toBe(false);
    expect(() => verifyProviderPreflightReplayReceipt({
      ...current,
      evidence_request_template_sha256:
        "38fa28af7f5d2a1895cc6cd6879ba3de827800c2713af054f976d3175a348200"
    })).toThrow("semantic contract does not match");
  });

  it.each([
    ["model", { model: "other-model" }],
    ["profile", { profile: "provider-default-v1" }],
    ["key count", { key_count: 999 }],
    ["request digest", { request_manifest_sha256: "1".repeat(64) }],
    ["cache digest", { cache_manifest_sha256: "2".repeat(64) }]
  ])("rejects same-shape %s drift from its canonical authority", async (_label, drift) => {
    const body = await createCanonicalReplayManifestBody((root) => {
      roots.push(root);
    });
    const manifest = sealReplayManifest(body);
    const receipt = receiptForManifest(manifest);
    const cacheRoot = body.request.extractionCacheRoot!;
    const manifestPath = join(cacheRoot, "receipt-request.json");
    const receiptPath = join(cacheRoot, "receipt.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

    expect(() => verifyProviderPreflightReplayReceiptBinding(receipt, manifest))
      .not.toThrow();
    await expect(runProviderPreflightCommand([
      "--mode", "validate-replay-receipt",
      "--receipt", receiptPath,
      "--request-manifest", manifestPath
    ])).resolves.toBe(0);
    expect(() => verifyProviderPreflightReplayReceiptBinding({
      ...receipt,
      ...drift
    }, manifest)).toThrow("does not match its canonical request authority");
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, ...drift })}\n`);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(runProviderPreflightCommand([
      "--mode", "validate-replay-receipt",
      "--receipt", receiptPath,
      "--request-manifest", manifestPath
    ])).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      "does not match its canonical request authority"
    ));
    stderr.mockRestore();
  });
});
