import { describe, expect, it } from "vitest";
import { canonicalJson as protocolCanonicalJson } from "@do-soul/alaya-protocol";
import { canonicalJson } from "../../gates/canonical-json.js";

const MIXED_KEYS = { a: 1, B: 2, "": 0 } as const;

describe("eval canonicalJson", () => {
  it("matches the protocol authority for mixed-case and empty keys", () => {
    expect(canonicalJson(MIXED_KEYS)).toBe(protocolCanonicalJson(MIXED_KEYS));
    expect(canonicalJson(MIXED_KEYS)).toBe('{"":0,"B":2,"a":1}');
    expect(canonicalJson({ B: 2, a: 1, "": 0 })).toBe(canonicalJson(MIXED_KEYS));
  });
});
