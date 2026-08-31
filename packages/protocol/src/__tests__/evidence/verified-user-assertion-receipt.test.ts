import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX,
  buildVerifiedUserAssertionReceiptPreimage,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionSourceHash,
  formatVerifiedUserAssertionV2SourceHash,
  parseVerifiedUserAssertionCatalogLocator,
  parseVerifiedUserAssertionSourceHash,
  readVerifiedUserAssertionSourceHashDigest,
  readVerifiedUserAssertionV2SourceHashDigest,
  verifyLegacyVerifiedUserAssertionV1SourceHash,
  verifyVerifiedUserAssertionSourceHash,
  type VerifiedUserAssertionReceiptInput,
  type VerifiedUserAssertionReceiptV2Input
} from "../../index.js";

const V1_INPUT: VerifiedUserAssertionReceiptInput = {
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: "surface-1",
  source_assertion: "I prefer tea.",
  source_corpus: "User: I prefer tea."
};

const V2_INPUT: VerifiedUserAssertionReceiptV2Input = {
  ...V1_INPUT,
  signal_id: "signal-1",
  source_locator: {
    contract_version: 2,
    kind: "assertion_catalog",
    assertion_id: 1
  }
};

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage).digest("hex");
}

function receiptV1(input: VerifiedUserAssertionReceiptInput = V1_INPUT): string {
  return formatVerifiedUserAssertionSourceHash(
    sha256(buildVerifiedUserAssertionReceiptPreimage(input))
  );
}

function receiptV2(input: VerifiedUserAssertionReceiptV2Input = V2_INPUT): string {
  return formatVerifiedUserAssertionV2SourceHash(
    sha256(buildVerifiedUserAssertionReceiptV2Preimage(input))
  );
}

describe("verified user assertion receipt compatibility", () => {
  it("preserves the v1 prefix, preimage, formatter, and digest reader", () => {
    const digest = "a".repeat(64);

    expect(VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX).toBe(
      "sha256:garden-verified-user-assertion-v1:"
    );
    expect(buildVerifiedUserAssertionReceiptPreimage(V1_INPUT)).toBe(JSON.stringify({
      version: 1,
      receipt_kind: "garden_verified_user_assertion_v1",
      source_role: "user",
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: "surface-1",
      source_assertion: "I prefer tea.",
      source_corpus: "User: I prefer tea."
    }));
    expect(formatVerifiedUserAssertionSourceHash(digest)).toBe(
      `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}${digest}`
    );
    expect(readVerifiedUserAssertionSourceHashDigest(
      `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}${digest}`
    )).toBe(digest);
  });
});

describe("verified user assertion receipt v2", () => {
  it("binds signal identity, assertion-catalog locator, runtime identity, and source bytes", () => {
    expect(VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX).toBe(
      "sha256:garden-verified-user-assertion-v2:"
    );
    expect(buildVerifiedUserAssertionReceiptV2Preimage(V2_INPUT)).toBe(JSON.stringify({
      version: 2,
      receipt_kind: "garden_verified_user_assertion_v2",
      source_role: "user",
      signal_id: "signal-1",
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1
      },
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: "surface-1",
      source_assertion: "I prefer tea.",
      source_corpus: "User: I prefer tea."
    }));
  });

  it("formats and reads only exact lowercase v2 digests", () => {
    const digest = "b".repeat(64);
    const receipt = formatVerifiedUserAssertionV2SourceHash(digest);

    expect(receipt).toBe(`${VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX}${digest}`);
    expect(readVerifiedUserAssertionV2SourceHashDigest(receipt)).toBe(digest);
    expect(readVerifiedUserAssertionV2SourceHashDigest(
      `${VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX}${"B".repeat(64)}`
    )).toBeNull();
    expect(readVerifiedUserAssertionV2SourceHashDigest(receiptV1())).toBeNull();
  });
});

describe("parseVerifiedUserAssertionSourceHash", () => {
  it("parses either exact receipt format and rejects lookalikes", () => {
    expect(parseVerifiedUserAssertionSourceHash(receiptV1())).toEqual({
      version: 1,
      digest: sha256(buildVerifiedUserAssertionReceiptPreimage(V1_INPUT))
    });
    expect(parseVerifiedUserAssertionSourceHash(receiptV2())).toEqual({
      version: 2,
      digest: sha256(buildVerifiedUserAssertionReceiptV2Preimage(V2_INPUT))
    });
    expect(parseVerifiedUserAssertionSourceHash(null)).toBeNull();
    expect(parseVerifiedUserAssertionSourceHash("sha256:garden-verified-user-assertion-v3:" +
      "c".repeat(64))).toBeNull();
    expect(parseVerifiedUserAssertionSourceHash(
      `${VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX}${"c".repeat(63)}`
    )).toBeNull();
  });
});

describe("verifyVerifiedUserAssertionSourceHash", () => {
  it("parses only the exact positive assertion-catalog locator shape", () => {
    expect(parseVerifiedUserAssertionCatalogLocator(V2_INPUT.source_locator))
      .toEqual(V2_INPUT.source_locator);
    expect(parseVerifiedUserAssertionCatalogLocator({
      ...V2_INPUT.source_locator,
      extra: true
    })).toBeNull();
    expect(parseVerifiedUserAssertionCatalogLocator({
      ...V2_INPUT.source_locator,
      assertion_id: 0
    })).toBeNull();
  });

  it("verifies exact v1 and v2 preimage digests through the supplied hash callback", () => {
    expect(verifyVerifiedUserAssertionSourceHash(receiptV1(), V1_INPUT, sha256)).toBe(true);
    expect(verifyVerifiedUserAssertionSourceHash(receiptV2(), V2_INPUT, sha256)).toBe(true);
  });

  it.each([
    ["workspace", { ...V2_INPUT, workspace_id: "workspace-2" }],
    ["run", { ...V2_INPUT, run_id: "run-2" }],
    ["surface", { ...V2_INPUT, surface_id: "surface-2" }],
    ["signal", { ...V2_INPUT, signal_id: "signal-2" }],
    ["locator", {
      ...V2_INPUT,
      source_locator: { ...V2_INPUT.source_locator, assertion_id: 2 }
    }],
    ["assertion", {
      ...V2_INPUT,
      source_assertion: "prefer tea",
      source_corpus: "User: I prefer tea."
    }],
    ["corpus", { ...V2_INPUT, source_corpus: "User: Today I prefer tea." }]
  ] satisfies ReadonlyArray<readonly [string, VerifiedUserAssertionReceiptV2Input]>) (
    "rejects a v2 %s substitution",
    (_field, input) => {
      expect(verifyVerifiedUserAssertionSourceHash(receiptV2(), input, sha256)).toBe(false);
    }
  );

  it("rejects an exact digest under the wrong receipt version", () => {
    const v1DigestAsV2 = formatVerifiedUserAssertionV2SourceHash(
      sha256(buildVerifiedUserAssertionReceiptPreimage(V1_INPUT))
    );
    expect(verifyVerifiedUserAssertionSourceHash(v1DigestAsV2, V2_INPUT, sha256)).toBe(false);
  });

  it("applies the canonical corpus gate to v1 receipts", () => {
    const duplicateAssertion = {
      ...V1_INPUT,
      source_assertion: "tea",
      source_corpus: "User: tea then tea"
    };
    expect(verifyVerifiedUserAssertionSourceHash(
      receiptV1(duplicateAssertion),
      duplicateAssertion,
      sha256
    )).toBe(false);
  });

  it("isolates digest-valid non-canonical v1 receipts to the migration verifier", () => {
    const legacyInput = {
      ...V1_INPUT,
      source_corpus: "User: I prefer tea.\nAssistant: acknowledged."
    };
    const receipt = receiptV1(legacyInput);

    expect(verifyLegacyVerifiedUserAssertionV1SourceHash(
      receipt,
      legacyInput,
      sha256
    )).toBe(true);
    expect(verifyVerifiedUserAssertionSourceHash(receipt, legacyInput, sha256)).toBe(false);
  });

  it.each([
    ["missing exact prefix", " User: I prefer tea.", "I prefer tea."],
    ["lowercase role", "user: I prefer tea.", "I prefer tea."],
    ["carriage return", "User: I prefer\rtea.", "I prefer tea."],
    ["line feed", "User: I prefer\ntea.", "I prefer tea."],
    ["line separator", "User: I prefer\u2028tea.", "I prefer tea."],
    ["paragraph separator", "User: I prefer\u2029tea.", "I prefer tea."],
    ["missing assertion", "User: I prefer coffee.", "I prefer tea."],
    ["duplicate assertion", "User: tea then tea", "tea"],
    ["empty assertion", "User: I prefer tea.", ""]
  ])("rejects a non-canonical corpus: %s", (_reason, sourceCorpus, sourceAssertion) => {
    const input = {
      ...V2_INPUT,
      source_corpus: sourceCorpus,
      source_assertion: sourceAssertion
    };
    expect(verifyVerifiedUserAssertionSourceHash(receiptV2(input), input, sha256)).toBe(false);
  });

  it("rejects malformed v2 assertion-catalog locators before hashing", () => {
    const malformed = {
      ...V2_INPUT,
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 0
      }
    } as VerifiedUserAssertionReceiptV2Input;
    let hashCalls = 0;

    expect(verifyVerifiedUserAssertionSourceHash(receiptV2(V2_INPUT), malformed, (preimage) => {
      hashCalls += 1;
      return sha256(preimage);
    })).toBe(false);
    expect(hashCalls).toBe(0);
  });
});
