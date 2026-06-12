import { describe, expect, it } from "vitest";
import {
  computeRequestKey,
  type PairInput
} from "../../ai/edge-auto-producer-llm-adapter.js";

// invariant: the disk decision cache keys verdicts by sha256 over the
// model id + all pair fields. The field separator must keep field
// boundaries distinct so two pairs that differ only by where a boundary
// falls cannot collide onto the same cache entry (which would serve one
// pair's verdict for the other). FIELD_SEPARATOR must be a non-empty byte
// absent from every field.
// see also: edge-auto-producer-llm-adapter.ts computeRequestKey.
describe("edge-auto-producer llm adapter computeRequestKey", () => {
  const baseModel = "gpt-x";
  const baseScope = "project";
  const baseDimension = "fact";

  function pair(overrides: Partial<PairInput>): PairInput {
    return {
      newContent: "a",
      newTags: [],
      neighborContent: "b",
      neighborTags: [],
      dimension: baseDimension,
      scopeClass: baseScope,
      ...overrides
    };
  }

  it("produces distinct keys for field-boundary-shifted content pairs", () => {
    // Same concatenation if fields were joined with no separator: both
    // pairs flatten to "ab" across newContent+neighborContent. A no-op
    // separator collides them; a real separator must not.
    const left = computeRequestKey(baseModel, pair({ newContent: "ab", neighborContent: "c" }));
    const right = computeRequestKey(baseModel, pair({ newContent: "a", neighborContent: "bc" }));
    expect(left).not.toBe(right);
  });

  it("produces distinct keys for field-boundary-shifted tag pairs", () => {
    // newTags ["a","b"] vs ["ab"] join identically if tags are flattened
    // with no inter-tag delimiter; the sorted-join + separator must keep
    // the two cases distinct from each other and from a shifted neighbor.
    const left = computeRequestKey(baseModel, pair({ newTags: ["a", "b"], neighborTags: [] }));
    const right = computeRequestKey(baseModel, pair({ newTags: ["ab"], neighborTags: [] }));
    expect(left).not.toBe(right);
  });

  it("produces distinct keys when the model id boundary shifts into a field", () => {
    const left = computeRequestKey("gp", pair({ newContent: "tx" }));
    const right = computeRequestKey("gptx", pair({ newContent: "" }));
    expect(left).not.toBe(right);
  });

  it("is stable for the same pair and tag ordering does not change the key", () => {
    const a = computeRequestKey(baseModel, pair({ newTags: ["x", "y"], neighborTags: ["m"] }));
    const b = computeRequestKey(baseModel, pair({ newTags: ["y", "x"], neighborTags: ["m"] }));
    expect(a).toBe(b);
  });
});
