import { describe, expect, it } from "vitest";
import {
  MemoryObjectKeySchema,
  MemoryObjectKeyTypeSchema,
  normalizeMemoryObjectKeySurface
} from "../../memory/memory-object-key.js";

describe("MemoryObjectKeySchema", () => {
  it("parses a gist-remainder key bound to a memory owner with an evidence receipt", () => {
    const key = {
      schema_version: 1 as const,
      key_id: "gist-golden-retriever",
      owner_id: "memory-1",
      workspace_id: "workspace-1",
      key_type: "gist_remainder" as const,
      surface: "Golden Retriever",
      normalized_surface: "golden retriever",
      language: "en" as const,
      source_kind: "evidence_gist" as const,
      source_ref: "evidence:capsule-1:gist:12:28"
    };

    expect(MemoryObjectKeySchema.parse(key)).toEqual(key);
  });

  it("rejects a gist remainder whose normalized form is not canonical", () => {
    expect(() => MemoryObjectKeySchema.parse({
      schema_version: 1,
      key_id: "gist-bad",
      owner_id: "memory-1",
      workspace_id: "workspace-1",
      key_type: "gist_remainder",
      surface: "Golden Retriever",
      normalized_surface: "other",
      language: "en",
      source_kind: "evidence_gist",
      source_ref: "evidence:capsule-1:gist:0:4"
    })).toThrow(/canonical form/u);
  });

  it("allows a temporal alias whose surface differs from its normalized source form", () => {
    const key = {
      schema_version: 1 as const,
      key_id: "alias-february-8",
      owner_id: "memory-1",
      workspace_id: "workspace-1",
      key_type: "temporal_alias" as const,
      surface: "February 8",
      normalized_surface: "february 8",
      language: "en" as const,
      source_kind: "stored_text" as const,
      source_ref: "evidence:capsule-1:gist:surface:2/8"
    };

    expect(MemoryObjectKeySchema.parse(key)).toEqual(key);
  });

  it("exposes the complementary key types used by local minting", () => {
    expect(MemoryObjectKeyTypeSchema.options).toEqual([
      "gist_remainder",
      "osf_surface",
      "osf_identity",
      "temporal_alias",
      "numeric_alias"
    ]);
  });
});

describe("normalizeMemoryObjectKeySurface", () => {
  it("collapses NFKC whitespace and case for complementarity", () => {
    expect(normalizeMemoryObjectKeySurface("  Golden\tRetriever  ")).toBe("golden retriever");
  });
});
