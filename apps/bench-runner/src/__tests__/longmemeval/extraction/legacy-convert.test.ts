import { describe, expect, it } from "vitest";
import { convertLegacyExtractionShard } from
  "../../../runs/extraction/cache/semantic-artifact/legacy-convert.js";
import {
  readVerifiedLegacyExtractionEntry,
  type VerifiedLegacyExtractionEntry
} from "../../../runs/extraction/cache/semantic-artifact/legacy-sealed-entry.js";
import { semanticTask } from "./semantic-artifact-fixture.js";

const DIGEST = "11".repeat(32);

describe("legacy shard conversion", () => {
  it("rejects caller self-signed pins without opaque external authority", () => {
    expect(() => readVerifiedLegacyExtractionEntry({
      root: "/tmp/caller-selected-legacy-root",
      cacheKey: DIGEST,
      inventory: {
        manifestSha256: DIGEST,
        entries: {
          [DIGEST]: { fileSha256: DIGEST, completionWitnessSha256: DIGEST }
        }
      }
    } as never)).toThrow(/loaded extraction authority/u);
  });

  it("rejects structurally forged legacy reader handles", () => {
    const task = semanticTask();
    const report = convertLegacyExtractionShard({
      sealedEntry: {
        cacheKey: DIGEST,
        fileSha256: DIGEST,
        completionWitnessSha256: DIGEST
      } as VerifiedLegacyExtractionEntry,
      request: {
        schema_version: 2,
        source_locator_contract_version: 2,
        batch_contract_version: 1,
        source_corpus_identity: task.binding.sourceCorpusIdentity,
        batch_index: 0,
        batch_count: 1,
        source_assertions: [{ assertion_id: task.assertionId, text: task.text }]
      },
      sourceUnits: [task],
      semanticContract: task.semanticContract,
      expectedSystemPrompt: "sealed prompt"
    });
    expect(report.converted).toEqual([]);
    expect(report.unresolved[0]?.reason).toMatch(/authority-bound reader handle/u);
  });
});
