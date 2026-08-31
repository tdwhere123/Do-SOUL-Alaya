import { describe, expect, it } from "vitest";
import {
  inspectCachedResponseMetadata,
  persistedResponseMetadata
} from "../../../runs/compile-seed/cache/cached-response-metadata.js";

describe("cached provider completion authority", () => {
  it("rejects provider-backed writes without a versioned witness", () => {
    expect(() => persistedResponseMetadata(undefined, undefined, true)).toThrow(
      "provider-backed response_metadata lacks versioned completion authority"
    );
    expect(() => persistedResponseMetadata({ finishReason: "stop" }, undefined, true)).toThrow(
      "provider-backed response_metadata lacks versioned completion authority"
    );
  });

  it("rejects provider-backed reads with absent or legacy metadata", () => {
    expect(() => inspectCachedResponseMetadata(undefined, true)).toThrow(
      "provider-backed response_metadata is required"
    );
    expect(() => inspectCachedResponseMetadata({ finish_reason: "stop" }, true)).toThrow(
      "provider-backed response_metadata lacks versioned completion authority"
    );
  });

  it("keeps deterministic no-provider artifacts valid without metadata", () => {
    expect(inspectCachedResponseMetadata(undefined, false)).toEqual({});
    expect(persistedResponseMetadata(undefined, undefined, false)).toEqual({});
  });

  it("rejects a legacy null finish reason without a completion witness", () => {
    expect(() => inspectCachedResponseMetadata({ finish_reason: null })).toThrow(
      "null finish_reason lacks completion authority"
    );
  });

  it("round-trips a versioned completion witness", () => {
    const persisted = persistedResponseMetadata({
      finishReason: null,
      completionContractVersion: 1,
      completionWitness: "done_sentinel"
    }, undefined, true);

    expect(persisted).toEqual({
      response_metadata: {
        finish_reason: null,
        completion_contract_version: 1,
        completion_witness: "done_sentinel"
      }
    });
    expect(inspectCachedResponseMetadata(persisted.response_metadata, true)).toEqual({
      responseMetadata: {
        finishReason: null,
        completionContractVersion: 1,
        completionWitness: "done_sentinel"
      }
    });
  });
});
