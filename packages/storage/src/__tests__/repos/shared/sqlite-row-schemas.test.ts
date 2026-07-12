import { describe, expect, it } from "vitest";
import {
  MemoryEmbeddingMetadataRowParser,
  MemoryEmbeddingRowParser,
  StrongRefRowParser,
  SurfaceBindingRowParser
} from "../../../repos/shared/sqlite-row-schemas.js";

const VALID_SURFACE_BINDING_ROW = {
  binding_id: "binding-1",
  object_kind: "surface_binding",
  schema_version: 1,
  lifecycle_state: "active",
  created_at: "2026-03-22T00:00:00.000Z",
  updated_at: "2026-03-22T00:00:00.000Z",
  created_by: "user",
  object_id: "claim://object-1",
  surface_id: "surface://main",
  is_primary: 1,
  binding_state: "active",
  workspace_id: "workspace-1"
} as const;

const VALID_STRONG_REF_ROW = {
  ref_id: "strong-ref-1",
  source_entity_type: "governance_lease",
  source_entity_id: "lease-1",
  target_entity_type: "claim_form",
  target_entity_id: "claim-1",
  workspace_id: "workspace-1",
  reason: "governance_lease",
  created_at: "2026-04-15T00:00:00.000Z"
} as const;

const VALID_MEMORY_EMBEDDING_ROW = {
  object_id: "memory-1",
  workspace_id: "workspace-1",
  content_hash: "sha256:abc",
  provider_kind: "openai",
  model_id: "text-embedding-3-small",
  schema_version: 1,
  dimensions: 2,
  embedding_blob: Buffer.from(new Float32Array([0.1, 0.2]).buffer),
  created_at: "2026-03-22T00:00:00.000Z",
  updated_at: "2026-03-22T00:00:00.000Z"
} as const;

describe("sqlite row schemas", () => {
  it("parses valid surface binding rows", () => {
    expect(SurfaceBindingRowParser.parse(VALID_SURFACE_BINDING_ROW)).toEqual(VALID_SURFACE_BINDING_ROW);
  });

  it("rejects invalid surface binding rows", () => {
    expect(() =>
      SurfaceBindingRowParser.parse({ ...VALID_SURFACE_BINDING_ROW, is_primary: 2 })
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("parses valid strong ref rows", () => {
    expect(StrongRefRowParser.parse(VALID_STRONG_REF_ROW)).toEqual(VALID_STRONG_REF_ROW);
  });

  it("rejects invalid strong ref rows", () => {
    expect(() =>
      StrongRefRowParser.parse({ ...VALID_STRONG_REF_ROW, reason: "not-a-reason" })
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("parses valid memory embedding rows", () => {
    expect(MemoryEmbeddingRowParser.parse(VALID_MEMORY_EMBEDDING_ROW)).toEqual(VALID_MEMORY_EMBEDDING_ROW);
  });

  it("rejects invalid memory embedding rows", () => {
    expect(() =>
      MemoryEmbeddingRowParser.parse({ ...VALID_MEMORY_EMBEDDING_ROW, embedding_blob: "not-a-buffer" })
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("parses valid memory embedding metadata rows", () => {
    const { embedding_blob: _ignored, ...metadataRow } = VALID_MEMORY_EMBEDDING_ROW;
    expect(MemoryEmbeddingMetadataRowParser.parse(metadataRow)).toEqual(metadataRow);
  });

  it("rejects invalid memory embedding metadata rows", () => {
    const { embedding_blob: _ignored, ...metadataRow } = VALID_MEMORY_EMBEDDING_ROW;
    expect(() =>
      MemoryEmbeddingMetadataRowParser.parse({ ...metadataRow, dimensions: 0 })
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
