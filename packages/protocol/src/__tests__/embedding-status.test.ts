import { describe, expect, it } from "vitest";
import {
  EmbeddingEffectiveModeSchema,
  EmbeddingStatusSchema
} from "../soul/embedding-status.js";

describe("EmbeddingStatusSchema", () => {
  it("accepts the no-secret embedding posture contract", () => {
    const status = {
      workspace_id: "ws-1",
      embedding_enabled: true,
      provider_configured: true,
      model_id: "text-embedding-3-small",
      storage_available: true,
      effective_mode: "embedding_supplement",
      degraded_reason: null,
      checked_at: "2026-04-24T08:00:00.000Z"
    } as const;

    expect(EmbeddingStatusSchema.parse(status)).toEqual(status);
    expect(EmbeddingEffectiveModeSchema.options).toEqual([
      "keyword_only",
      "embedding_supplement",
      "degraded"
    ]);
  });

  it("rejects secrets and unknown effective modes", () => {
    expect(() =>
      EmbeddingStatusSchema.parse({
        workspace_id: "ws-1",
        embedding_enabled: false,
        provider_configured: true,
        model_id: "text-embedding-3-small",
        storage_available: true,
        effective_mode: "keyword_only",
        degraded_reason: null,
        checked_at: "2026-04-24T08:00:00.000Z",
        api_key: "sk-secret"
      })
    ).toThrow();

    expect(() =>
      EmbeddingStatusSchema.parse({
        workspace_id: "ws-1",
        embedding_enabled: true,
        provider_configured: true,
        model_id: "text-embedding-3-small",
        storage_available: true,
        effective_mode: "semantic_only",
        degraded_reason: null,
        checked_at: "2026-04-24T08:00:00.000Z"
      })
    ).toThrow();
  });

  it("requires degraded reasons only for degraded posture", () => {
    expect(() =>
      EmbeddingStatusSchema.parse({
        workspace_id: "ws-1",
        embedding_enabled: true,
        provider_configured: false,
        model_id: null,
        storage_available: true,
        effective_mode: "degraded",
        degraded_reason: null,
        checked_at: "2026-04-24T08:00:00.000Z"
      })
    ).toThrow("degraded_reason is required");

    expect(() =>
      EmbeddingStatusSchema.parse({
        workspace_id: "ws-1",
        embedding_enabled: false,
        provider_configured: true,
        model_id: "text-embedding-3-small",
        storage_available: true,
        effective_mode: "keyword_only",
        degraded_reason: "provider_unconfigured",
        checked_at: "2026-04-24T08:00:00.000Z"
      })
    ).toThrow("degraded_reason is only allowed");
  });

  it("rejects contradictory effective-mode posture", () => {
    const baseStatus = {
      workspace_id: "ws-1",
      embedding_enabled: true,
      provider_configured: true,
      model_id: "text-embedding-3-small",
      storage_available: true,
      effective_mode: "embedding_supplement" as const,
      degraded_reason: null,
      checked_at: "2026-04-24T08:00:00.000Z"
    };

    expect(() =>
      EmbeddingStatusSchema.parse({
        ...baseStatus,
        embedding_enabled: false
      })
    ).toThrow("disabled embeddings must use keyword_only");

    expect(() =>
      EmbeddingStatusSchema.parse({
        ...baseStatus,
        provider_configured: false
      })
    ).toThrow("embedding_supplement effective_mode requires provider_configured");

    expect(() =>
      EmbeddingStatusSchema.parse({
        ...baseStatus,
        storage_available: false
      })
    ).toThrow("embedding_supplement effective_mode requires storage_available");

    expect(() =>
      EmbeddingStatusSchema.parse({
        ...baseStatus,
        embedding_enabled: false,
        effective_mode: "degraded",
        degraded_reason: "provider_unconfigured"
      })
    ).toThrow("degraded effective_mode requires embedding_enabled");

    expect(EmbeddingStatusSchema.parse({
      ...baseStatus,
      effective_mode: "degraded",
      degraded_reason: "query_embedding_failed"
    })).toMatchObject({
      effective_mode: "degraded",
      degraded_reason: "query_embedding_failed"
    });
  });
});
