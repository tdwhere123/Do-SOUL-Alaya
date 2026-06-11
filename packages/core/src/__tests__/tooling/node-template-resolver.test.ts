import { describe, expect, it } from "vitest";
import { CoreError } from "../../errors.js";
import { NodeTemplateResolver } from "../../tooling/node-template-resolver.js";

describe("NodeTemplateResolver", () => {
  it("resolves all four frozen template contracts", () => {
    const resolver = new NodeTemplateResolver();

    expect(resolver.resolve("analyze").tools).toEqual(["read", "validation", "evidence"]);
    expect(resolver.resolve("plan").tools).toEqual(["read", "validation", "governance"]);
    expect(resolver.resolve("build").tools).toEqual(["read", "write", "exec", "validation"]);
    expect(resolver.resolve("review").tools).toEqual(["read", "validation", "evidence"]);
  });

  it("rejects unknown template kinds", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.resolve("unknown-kind" as never)).toThrowError(
      new CoreError("NOT_FOUND", "Unknown node template kind: unknown-kind")
    );
  });

  it("accepts boundary budget values and rejects budget overruns — analyze (max 3 tool calls, 0 delegations)", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.validateBudget("analyze", 0, 0)).not.toThrow();
    expect(() => resolver.validateBudget("analyze", 3, 0)).not.toThrow();
    expect(() => resolver.validateBudget("analyze", -1, 0)).toThrowError(
      new CoreError("VALIDATION", "Tool calls -1 must be a non-negative integer")
    );
    expect(() => resolver.validateBudget("analyze", 0, -1)).toThrowError(
      new CoreError("VALIDATION", "Delegations -1 must be a non-negative integer")
    );
    expect(() => resolver.validateBudget("analyze", 4, 0)).toThrowError(
      new CoreError("VALIDATION", "Tool calls 4 exceeds analyze template max (3)")
    );
    expect(() => resolver.validateBudget("analyze", 0, 1)).toThrowError(
      new CoreError("VALIDATION", "Delegations 1 exceeds analyze template max (0)")
    );
  });

  it("accepts boundary budget values and rejects budget overruns — plan (max 4 tool calls, 1 delegation)", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.validateBudget("plan", 0, 0)).not.toThrow();
    expect(() => resolver.validateBudget("plan", 4, 1)).not.toThrow();
    expect(() => resolver.validateBudget("plan", 5, 1)).toThrowError(
      new CoreError("VALIDATION", "Tool calls 5 exceeds plan template max (4)")
    );
    expect(() => resolver.validateBudget("plan", 4, 2)).toThrowError(
      new CoreError("VALIDATION", "Delegations 2 exceeds plan template max (1)")
    );
  });

  it("accepts boundary budget values and rejects budget overruns — build (max 8 tool calls, 2 delegations)", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.validateBudget("build", 0, 0)).not.toThrow();
    expect(() => resolver.validateBudget("build", 8, 2)).not.toThrow();
    expect(() => resolver.validateBudget("build", 9, 2)).toThrowError(
      new CoreError("VALIDATION", "Tool calls 9 exceeds build template max (8)")
    );
    expect(() => resolver.validateBudget("build", 8, 3)).toThrowError(
      new CoreError("VALIDATION", "Delegations 3 exceeds build template max (2)")
    );
  });

  it("accepts boundary budget values and rejects budget overruns — review (max 2 tool calls, 0 delegations)", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.validateBudget("review", 0, 0)).not.toThrow();
    expect(() => resolver.validateBudget("review", 2, 0)).not.toThrow();
    expect(() => resolver.validateBudget("review", 3, 0)).toThrowError(
      new CoreError("VALIDATION", "Tool calls 3 exceeds review template max (2)")
    );
    expect(() => resolver.validateBudget("review", 0, 1)).toThrowError(
      new CoreError("VALIDATION", "Delegations 1 exceeds review template max (0)")
    );
  });

  it("accepts NaN and float inputs as invalid integers", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.validateBudget("analyze", NaN, 0)).toThrowError(
      new CoreError("VALIDATION", "Tool calls NaN must be a non-negative integer")
    );
    expect(() => resolver.validateBudget("analyze", 1.5, 0)).toThrowError(
      new CoreError("VALIDATION", "Tool calls 1.5 must be a non-negative integer")
    );
    expect(() => resolver.validateBudget("analyze", 0, 1.5)).toThrowError(
      new CoreError("VALIDATION", "Delegations 1.5 must be a non-negative integer")
    );
  });

  it("accepts allowed tool categories and rejects disallowed categories — analyze and build", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.validateToolCategories("analyze", ["read", "validation"])).not.toThrow();
    expect(() => resolver.validateToolCategories("analyze", ["write"])).toThrowError(
      new CoreError("VALIDATION", "Tool categories [write] not allowed by analyze template")
    );
    expect(() =>
      resolver.validateToolCategories("build", ["read", "write", "exec", "validation"])
    ).not.toThrow();
    expect(() => resolver.validateToolCategories("build", ["governance"])).toThrowError(
      new CoreError("VALIDATION", "Tool categories [governance] not allowed by build template")
    );
  });

  it("accepts allowed tool categories and rejects disallowed categories — plan", () => {
    const resolver = new NodeTemplateResolver();

    expect(() => resolver.validateToolCategories("plan", ["read", "validation", "governance"])).not.toThrow();
    expect(() => resolver.validateToolCategories("plan", ["governance"])).not.toThrow();
    expect(() => resolver.validateToolCategories("plan", ["write"])).toThrowError(
      new CoreError("VALIDATION", "Tool categories [write] not allowed by plan template")
    );
    expect(() => resolver.validateToolCategories("plan", ["exec"])).toThrowError(
      new CoreError("VALIDATION", "Tool categories [exec] not allowed by plan template")
    );
  });

  it("accepts allowed tool categories and rejects disallowed categories — review", () => {
    const resolver = new NodeTemplateResolver();

    expect(() =>
      resolver.validateToolCategories("review", ["read", "validation", "evidence"])
    ).not.toThrow();
    expect(() => resolver.validateToolCategories("review", ["exec"])).toThrowError(
      new CoreError("VALIDATION", "Tool categories [exec] not allowed by review template")
    );
    expect(() => resolver.validateToolCategories("review", ["write"])).toThrowError(
      new CoreError("VALIDATION", "Tool categories [write] not allowed by review template")
    );
    expect(() => resolver.validateToolCategories("review", ["governance"])).toThrowError(
      new CoreError("VALIDATION", "Tool categories [governance] not allowed by review template")
    );
  });
});
