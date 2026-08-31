import { describe, expect, it } from "vitest";
import {
  PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND,
  normalizePathAnchorDigest,
  normalizePathAnchorRef
} from "../../index.js";

describe("normalizePathAnchorDigest", () => {
  it("exports the digest-kind to alias-domain mapping", () => {
    expect(PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND).toEqual({
      obligation: "path_anchor.obligation",
      concern: "path_anchor.concern",
      window: "path_anchor.window"
    });
  });

  it("preserves Unicode content when normalizing digests", () => {
    expect(normalizePathAnchorDigest("  Mixed 中文 Input  ", "obligation")).toBe(
      "mixed_中文_input"
    );
  });

  it("applies alias resolution for language-equivalent digests", () => {
    const aliasResolver = (input: string, domain: string) => {
      if (domain === "path_anchor.obligation" && input === "必须先跑测试") {
        return "must_run_tests";
      }

      return input;
    };

    expect(
      normalizePathAnchorDigest("必须先跑测试", "obligation", aliasResolver)
    ).toBe("must_run_tests");
  });
});

describe("normalizePathAnchorRef", () => {
  it("passes through object-based anchors unchanged", () => {
    const objectRef = {
      kind: "object",
      object_id: "object-1"
    } as const;
    const objectFacetRef = {
      kind: "object_facet",
      object_id: "object-1",
      facet_key: "status"
    } as const;

    expect(normalizePathAnchorRef(objectRef)).toEqual(objectRef);
    expect(normalizePathAnchorRef(objectFacetRef)).toEqual(objectFacetRef);
  });

  it("normalizes digest-bearing anchors without mutating object ids", () => {
    const aliasResolver = (input: string, domain: string) => {
      if (domain === "path_anchor.obligation" && input === "必须先跑测试") {
        return "must_run_tests";
      }

      if (domain === "path_anchor.concern" && input === "凭证泄露") {
        return "credential_leak";
      }

      if (domain === "path_anchor.window" && input === "下周") {
        return "next_week";
      }

      return input;
    };

    expect(
      normalizePathAnchorRef(
        {
          kind: "obligation",
          source_object_id: "object-1",
          obligation_digest: "必须先跑测试"
        },
        aliasResolver
      )
    ).toEqual({
      kind: "obligation",
      source_object_id: "object-1",
      obligation_digest: "must_run_tests"
    });

    expect(
      normalizePathAnchorRef(
        {
          kind: "risk_concern",
          source_object_id: "object-2",
          concern_digest: "凭证泄露"
        },
        aliasResolver
      )
    ).toEqual({
      kind: "risk_concern",
      source_object_id: "object-2",
      concern_digest: "credential_leak"
    });

    expect(
      normalizePathAnchorRef(
        {
          kind: "time_concern",
          source_object_id: "object-3",
          window_digest: "下周"
        },
        aliasResolver
      )
    ).toEqual({
      kind: "time_concern",
      source_object_id: "object-3",
      window_digest: "next_week"
    });
  });
});
