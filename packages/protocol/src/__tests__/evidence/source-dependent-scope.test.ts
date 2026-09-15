import { describe, expect, it } from "vitest";
import { hasUnquotedSourceDependentScope, isInsideSourceQuotation } from "../../evidence/source-dependent-scope.js";

describe("source dependent scope", () => {
  it.each(["if", "unless", "whenever", "only", "provided that", "providing that",
    "assuming that", "as long as", "on condition that"])("retains the unquoted %s dependency", (cue) => {
    expect(hasUnquotedSourceDependentScope(`Deploy ${cue} checks pass.`)).toBe(true);
    expect(hasUnquotedSourceDependentScope(`Deploy ${cue.toUpperCase()} checks pass.`)).toBe(true);
  });

  it.each([['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]])(
    "distinguishes quoted cues between %s and %s from following scope", (open, close) => {
      const quoted = `${open}only${close} is the label.`;
      expect(hasUnquotedSourceDependentScope(quoted)).toBe(false);
      expect(hasUnquotedSourceDependentScope(`${quoted} Deploy only after checks.`)).toBe(true);
      expect(isInsideSourceQuotation(quoted, open.length + 1)).toBe(true);
      expect(isInsideSourceQuotation(quoted, quoted.length)).toBe(false);
    }
  );

  it("keeps contractions and possessives outside quotation state", () => {
    expect(hasUnquotedSourceDependentScope("Don't deploy unless checks pass.")).toBe(true);
    expect(hasUnquotedSourceDependentScope("Parents' accounts work only after approval.")).toBe(true);
    expect(hasUnquotedSourceDependentScope("Alice’s account works only after approval.")).toBe(true);
    expect(isInsideSourceQuotation("plain text", 5)).toBe(false);
  });

  it("uses the requested half-open span without losing preceding quotation context", () => {
    const source = 'if ready, "only" is a label; deploy unless blocked.';
    expect(hasUnquotedSourceDependentScope(source, 3, 34)).toBe(false);
    expect(hasUnquotedSourceDependentScope(source, 34)).toBe(true);
    expect(hasUnquotedSourceDependentScope("only", 0, 0)).toBe(false);
    expect(hasUnquotedSourceDependentScope("gift provision", 0)).toBe(false);
  });
});
