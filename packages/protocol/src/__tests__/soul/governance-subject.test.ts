import { describe, expect, it } from "vitest";
import {
  ScopeClassSchema,
  canonicalizeToken,
  canonicalGovernanceSubject,
  type GovernanceSubject
} from "../../index.js";

type IfEquals<X, Y, A = true, B = false> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? A : B;
type IsReadonlyProperty<T, K extends keyof T> = IfEquals<
  { [P in K]: T[P] },
  { -readonly [P in K]: T[P] },
  false,
  true
>;
type AssertTrue<T extends true> = T;
type _GovernanceSubjectReadonlyChecks = [
  AssertTrue<IsReadonlyProperty<GovernanceSubject, "subject_domain">>,
  AssertTrue<IsReadonlyProperty<GovernanceSubject, "subject_qualifiers">>,
  AssertTrue<IsReadonlyProperty<GovernanceSubject, "canonical_key">>
];

describe("canonicalGovernanceSubject", () => {
  it("compiles a regular governance subject", () => {
    const subject = canonicalGovernanceSubject("code_style", { language: "TypeScript" });

    expect(subject).toEqual({
      subject_domain: "code_style",
      subject_qualifiers: { language: "typescript" },
      canonical_key: "code_style::language=typescript"
    });
  });

  it("is deterministic regardless of qualifier input order", () => {
    const left = canonicalGovernanceSubject("domain", { b: "2", a: "1" });
    const right = canonicalGovernanceSubject("domain", { a: "1", b: "2" });

    expect(left.canonical_key).toBe("domain::a=1,b=2");
    expect(left.canonical_key).toBe(right.canonical_key);
    expect(left.subject_qualifiers).toEqual(right.subject_qualifiers);
  });

  it("orders qualifiers by deterministic code-point comparison instead of locale rules", () => {
    const subject = canonicalGovernanceSubject("domain", { ä: "1", z: "2" });

    expect(subject.subject_qualifiers).toEqual({ z: "2", ä: "1" });
    expect(subject.canonical_key).toBe("domain::z=2,ä=1");
  });

  it("rejects when both domain and qualifiers are empty", () => {
    expect(() => canonicalGovernanceSubject("", {})).toThrow();
  });

  it("rejects when domain is whitespace only", () => {
    expect(() => canonicalGovernanceSubject("   ", { a: "1" })).toThrow();
  });

  it("normalizes lowercase and trim", () => {
    const subject = canonicalGovernanceSubject(" My Domain ");

    expect(subject.subject_domain).toBe("my_domain");
    expect(subject.canonical_key).toBe("my_domain");
  });

  it("replaces illegal characters with underscores", () => {
    const subject = canonicalGovernanceSubject("My Framework!");

    expect(subject.canonical_key).toBe("my_framework");
  });

  it("drops illegal punctuation after canonicalization", () => {
    const subject = canonicalGovernanceSubject("a!!b");

    expect(subject.canonical_key).toBe("ab");
  });

  it("drops qualifiers with empty values", () => {
    const subject = canonicalGovernanceSubject("domain", { a: "", b: "x" });

    expect(subject.subject_qualifiers).toEqual({ b: "x" });
    expect(subject.canonical_key).toBe("domain::b=x");
  });

  it("de-duplicates normalized qualifier keys and keeps the last write", () => {
    const qualifiers: Record<string, string> = {};
    qualifiers.A = "1";
    qualifiers["a "] = "2";

    const subject = canonicalGovernanceSubject("domain", qualifiers);

    expect(subject.subject_qualifiers).toEqual({ a: "2" });
    expect(subject.canonical_key).toBe("domain::a=2");
  });

  it("omits qualifier suffix when no qualifiers remain", () => {
    const subject = canonicalGovernanceSubject("domain");

    expect(subject.canonical_key).toBe("domain");
    expect(subject.canonical_key.includes("::")).toBe(false);
  });

  it("keeps unknown alias values after normalization", () => {
    const subject = canonicalGovernanceSubject("domain", { framework: "SvelteKit" });

    expect(subject.subject_qualifiers).toEqual({ framework: "sveltekit" });
    expect(subject.canonical_key).toBe("domain::framework=sveltekit");
  });

  it("preserves CJK letters in domains and qualifiers", () => {
    const subject = canonicalGovernanceSubject("用户.偏好", { 分类: "强制" });

    expect(subject).toEqual({
      subject_domain: "用户.偏好",
      subject_qualifiers: { 分类: "强制" },
      canonical_key: "用户.偏好::分类=强制"
    });
  });

  it("supports alias-driven canonical convergence across languages", () => {
    const aliasResolver = (input: string, domain: string) => {
      if (domain === "governance_subject.domain" && input === "用户偏好") {
        return "user_preference";
      }

      if (domain === "governance_subject.qualifier.framework" && input === "类型脚本") {
        return "typescript";
      }

      return input;
    };

    const zh = canonicalGovernanceSubject(
      "用户偏好",
      { framework: "类型脚本" },
      { aliasResolver }
    );
    const en = canonicalGovernanceSubject(
      "User Preference",
      { framework: "TypeScript" },
      { aliasResolver }
    );

    expect(zh.canonical_key).toBe("user_preference::framework=typescript");
    expect(zh.canonical_key).toBe(en.canonical_key);
  });
});

describe("canonicalizeToken", () => {
  it("preserves Unicode letters and replaces whitespace with underscores", () => {
    expect(canonicalizeToken("用户偏好")).toBe("用户偏好");
    expect(canonicalizeToken("  Mixed 中文 Input  ")).toBe("mixed_中文_input");
  });

  it("normalizes canonically equivalent Unicode strings to NFC", () => {
    expect(canonicalizeToken("Cafe\u0301")).toBe("café");
    expect(canonicalizeToken("Café")).toBe("café");
  });
});

describe("ScopeClassSchema", () => {
  it("parses all supported scope classes", () => {
    expect(ScopeClassSchema.parse("project")).toBe("project");
    expect(ScopeClassSchema.parse("global_domain")).toBe("global_domain");
    expect(ScopeClassSchema.parse("global_core")).toBe("global_core");
  });

  it("rejects unsupported scope class values", () => {
    expect(() => ScopeClassSchema.parse("workspace")).toThrow();
  });
});
