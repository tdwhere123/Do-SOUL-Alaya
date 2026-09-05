import { afterEach, describe, expect, it } from "vitest";
import { StorageTier } from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  freezeLexicalBoundProducerReceipt,
  freezeLexicalBoundProof,
  LEXICAL_LANE_UNIVERSE_PRODUCER_ID,
  verifyLexicalBoundProof
} from "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import {
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallRealStorage
} from "../../../shared/real-sqlite.test-support.js";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("lexical lane universe wire parity", () => {
  it("freezes the storage-emitted witness without a third protocol type", async () => {
    const { memoryEntryRepo } = await createRecallRealStorage((database) => {
      databases.add(database);
    });
    const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: objectId,
      content: "Stable review evidence needs exact witness lines."
    }));
    const field = await memoryEntryRepo.searchByKeywordField!(
      REAL_SQLITE_TEST_WORKSPACE_ID,
      "go stable",
      5,
      { tier: StorageTier.HOT },
      [],
      { variant: "lexical_relaxed" }
    );
    const receipt = field.lexical_raw_rank_receipt;
    if (receipt === undefined) throw new Error("expected captured receipt");
    const frozen = freezeLexicalBoundProducerReceipt(receipt);
    const porter = frozen!.lanes.find((lane) => lane.lane_id === "porter")?.evaluated_universe;
    const exact = frozen!.lanes.find((lane) => lane.lane_id === "exact")?.evaluated_universe;
    expect(porter?.producer_id).toBe(LEXICAL_LANE_UNIVERSE_PRODUCER_ID);
    expect(porter?.index_kind).toBe("memory_content_fts_porter");
    expect(exact?.index_kind).toBe("memory_entries");
    expect(porter?.candidate_keys).toEqual([objectId]);
    expect(porter?.scope).toEqual({
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      object_ids: null,
      tier: "hot"
    });
    expect(JSON.parse(JSON.stringify(frozen))).toEqual(JSON.parse(JSON.stringify(receipt)));
    const proof = freezeLexicalBoundProof(frozen);
    if (proof === undefined || proof.status !== "captured") {
      throw new Error("expected captured proof");
    }
    expect(proof.evaluated_universe.reason).toBe("candidate_universe_not_proved");
    expect(proof.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
    verifyLexicalBoundProof(proof);
  });
});
