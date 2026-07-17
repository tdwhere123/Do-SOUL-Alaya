import { describe, expect, it } from "vitest";
import {
  isRawPayloadBoundError,
  projectCompileRawPayload
} from "../../../harness/seeding/compile-raw-payload.js";

describe("compile raw payload projection", () => {
  it("hashes equivalent source objects deterministically while retaining semantic keys", () => {
    const first = projectCompileRawPayload({
      provider_diagnostics: "x".repeat(14_000),
      temporal_projection: { time_precision: "day", event_time_start: "2026-07-10" },
      matched_text: "durable fact",
      canonical_entities: ["source"]
    });
    const reordered = projectCompileRawPayload({
      canonical_entities: ["source"],
      matched_text: "durable fact",
      temporal_projection: { event_time_start: "2026-07-10", time_precision: "day" },
      provider_diagnostics: "x".repeat(14_000)
    });

    expect(first.bench_source_raw_payload_sha256).toBe(
      reordered.bench_source_raw_payload_sha256
    );
    expect(first).toMatchObject({
      matched_text: "durable fact",
      canonical_entities: ["source"],
      temporal_projection: { event_time_start: "2026-07-10", time_precision: "day" },
      bench_source_raw_payload_projected: true,
      bench_source_raw_payload_key_count: 4
    });
    expect(first).not.toHaveProperty("provider_diagnostics");
  });

  it("uses locale-independent code-unit ordering for the source digest", () => {
    const projected = projectCompileRawPayload({ "ä": 1, z: 2 });
    expect(projected.bench_source_raw_payload_sha256).toBe(
      "sha256:896b8dd27b9b539d56c30c96acce8910a2293d7bef3fc3ef87195bc2eb778073"
    );
  });

  it("recognizes only the raw-payload serialized-size validation failure", () => {
    expect(isRawPayloadBoundError({
      issues: [{ path: ["raw_payload"], message: "JSON object must serialize to at most 16384 characters." }]
    })).toBe(true);
    expect(isRawPayloadBoundError({
      issues: [{ path: ["confidence"], message: "Too big" }]
    })).toBe(false);
  });
});
