import { describe, expect, it } from "vitest";
import {
  canonicalGovernanceSubject,
  normalizePathAnchorRef,
  PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND
} from "@do-soul/alaya-protocol";
import { CanonicalAliasService } from "../../governance/canonical-alias-service.js";

describe("CanonicalAliasService", () => {
  it("resolves registered aliases and falls back to normalized input", () => {
    const service = new CanonicalAliasService({
      aliasMap: {
        "governance_subject.domain": [
          {
            alias: "用户偏好",
            canonical: "user_preference",
            language: "zh",
            domain: "governance_subject.domain"
          }
        ]
      }
    });

    expect(service.resolve("用户偏好", "governance_subject.domain")).toBe("user_preference");
    expect(service.resolve("User Preference", "governance_subject.domain")).toBe("user_preference");
    expect(service.resolve("Mixed 中文 Input", "governance_subject.domain")).toBe("mixed_中文_input");
  });

  it("registers aliases after construction", () => {
    const service = new CanonicalAliasService({
      aliasMap: {}
    });

    service.registerAlias({
      alias: "凭证泄露",
      canonical: "credential_leak",
      language: "zh",
      domain: "path_anchor.concern"
    });

    expect(service.resolveDigest("凭证泄露", "concern")).toBe("credential_leak");
  });

  it("uses protocol-owned digest-domain mapping for resolveDigest kinds", () => {
    const service = new CanonicalAliasService({
      aliasMap: {}
    });

    for (const [digestKind, aliasDomain] of Object.entries(PATH_ANCHOR_DIGEST_ALIAS_DOMAIN_BY_KIND)) {
      service.registerAlias({
        alias: `${digestKind}-alias`,
        canonical: `${digestKind}-canonical`,
        language: "en",
        domain: aliasDomain
      });
    }

    expect(service.resolveDigest("obligation-alias", "obligation")).toBe("obligation-canonical");
    expect(service.resolveDigest("concern-alias", "concern")).toBe("concern-canonical");
    expect(service.resolveDigest("window-alias", "window")).toBe("window-canonical");
  });

  it("produces the same governance subject key across languages when used as an alias resolver", () => {
    const service = new CanonicalAliasService({
      aliasMap: {
        "governance_subject.domain": [
          {
            alias: "用户偏好",
            canonical: "user_preference",
            language: "zh",
            domain: "governance_subject.domain"
          }
        ],
        "governance_subject.qualifier.framework": [
          {
            alias: "类型脚本",
            canonical: "typescript",
            language: "zh",
            domain: "governance_subject.qualifier.framework"
          }
        ]
      }
    });

    const zh = canonicalGovernanceSubject(
      "用户偏好",
      { framework: "类型脚本" },
      { aliasResolver: service.resolve.bind(service) }
    );
    const en = canonicalGovernanceSubject(
      "User Preference",
      { framework: "TypeScript" },
      { aliasResolver: service.resolve.bind(service) }
    );

    expect(zh.canonical_key).toBe("user_preference::framework=typescript");
    expect(zh.canonical_key).toBe(en.canonical_key);
  });

  it("normalizes PathAnchorRef digests through the same alias map", () => {
    const service = new CanonicalAliasService({
      aliasMap: {
        "path_anchor.obligation": [
          {
            alias: "必须先跑测试",
            canonical: "must_run_tests",
            language: "zh",
            domain: "path_anchor.obligation"
          }
        ]
      }
    });

    expect(
      normalizePathAnchorRef(
        {
          kind: "obligation",
          source_object_id: "object-1",
          obligation_digest: "必须先跑测试"
        },
        service.resolve.bind(service)
      )
    ).toEqual({
      kind: "obligation",
      source_object_id: "object-1",
      obligation_digest: "must_run_tests"
    });
  });
});
