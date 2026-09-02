import { describe, expect, it } from "vitest";
import {
  compactRunIdentity,
  resolveIngestionMode
} from "../../../runs/snapshot/ingestion-mode.js";
import { LongMemEvalRunProvenanceSchema } from
  "../../../runs/provenance/run-provenance-schema.js";

const SUBSTRATE = "11".repeat(32);
const OVERLAY_A = "22".repeat(32);
const OVERLAY_B = "33".repeat(32);

describe("ingestion mode run identity", () => {
  it("does not silently default legacy provenance without complete-v3 authority", () => {
    expect(() => resolveIngestionMode({ schemaVersion: 1 })).toThrow(/complete-v3/u);
    expect(resolveIngestionMode({
      schemaVersion: 1,
      completeV3Authority: true
    })).toBe("precomputed_full");
    expect(() => resolveIngestionMode({
      schemaVersion: 1,
      ingestionMode: "lazy_field",
      completeV3Authority: true
    })).toThrow(/cannot carry ingestion_mode/u);
  });

  it("separates same substrate under different ingestion modes", () => {
    const full = compactRunIdentity({
      substrateIdentity: SUBSTRATE,
      ingestionMode: "precomputed_full",
      overlayIdentity: OVERLAY_A
    });
    const lazy = compactRunIdentity({
      substrateIdentity: SUBSTRATE,
      ingestionMode: "lazy_field",
      overlayIdentity: OVERLAY_A
    });
    expect(full).not.toBe(lazy);
    expect(compactRunIdentity({
      substrateIdentity: SUBSTRATE,
      ingestionMode: "lazy_field",
      overlayIdentity: OVERLAY_A
    })).toBe(lazy);
    expect(compactRunIdentity({
      substrateIdentity: SUBSTRATE,
      ingestionMode: "lazy_field",
      overlayIdentity: OVERLAY_B
    })).not.toBe(lazy);
  });

  it("requires ingestion_mode on provenance schema v2", () => {
    expect(() => resolveIngestionMode({ schemaVersion: 2 })).toThrow(/requires ingestion_mode/u);
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      schema_version: 1,
      ingestion_mode: "precomputed_full"
    }).success).toBe(false);
  });
});
