import { afterEach, describe, expect, it } from "vitest";
import { SNAPSHOT_GATE_SHA } from
  "./promotion-entry-primitives-fixture.js";
import {
  cleanupPromotionEntryFixtureRoots,
  writeEntryFixture
} from "./promotion-entry-fixture.js";

afterEach(cleanupPromotionEntryFixtureRoots);

describe("recall-eval promotion entry verifier", () => {
  it.each([
    ["source", /canonical seed round identity/u],
    ["raw_digest", /cache closure mismatch/u],
    ["raw_count", /cache closure mismatch/u],
    ["draft_count", /cache closure mismatch/u],
    ["memory_ids", /signal conservation mismatch/u]
  ] as const)("rejects snapshot seed-ledger %s drift", async (tamperSeedLedger, error) => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, { tamperSeedLedger }))
      .rejects.toThrow(error);
  });

  it("rejects a cache-only summary that differs from the round ledger", async () => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, { seedFactsProducedOffset: 1 }))
      .rejects.toThrow(/summary differs from round ledger/u);
  });

  it.each([
    ["expected-turn inflation", "expected_turns", /cache closure mismatch/u],
    ["wrong content closure", "content_closure", /cache closure mismatch/u],
    ["wrong question window", "window", /question window mismatch/u]
  ] as const)("rejects promotion snapshot %s", async (
    _label,
    extractionAuthorityDrift,
    error
  ) => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, { extractionAuthorityDrift }))
      .rejects.toThrow(error);
  });

  it.each(["exact", "conflicting"] as const)(
    "rejects a %s duplicate object in the snapshot gold oracle",
    async (duplicateObject) => {
      await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, { duplicateObject }))
        .rejects.toThrow(/duplicate snapshot sidecar|session is absent|repeats object/u);
    }
  );

  it.each([
    ["question", /canonical question identity/u],
    ["question_date", /canonical question identity/u],
    ["answer_sessions", /canonical question identity/u],
    ["sidecar_session", /session is absent/u],
    ["has_answer", /answer marker mismatch/u],
    ["omit_distractor_round", /canonical seed round/u]
  ] as const)("rejects canonical snapshot %s drift", async (tamperCanonical, error) => {
    await expect(writeEntryFixture(SNAPSHOT_GATE_SHA, { tamperCanonical }))
      .rejects.toThrow(error);
  });
});
