import { describe, expect, it } from "vitest";
// RED: RunRenameInputSchema does not exist yet in ../run — import will fail at
// runtime (or compile time if tsc is strict) until the implementation card lands.
// @ts-expect-error symbol does not exist yet
import { RunRenameInputSchema } from "../run.js";
// RED: RunRenamedPayloadSchema does not exist yet in ../events/phase-0
// @ts-expect-error symbol does not exist yet
import { RunRenamedPayloadSchema } from "../events/phase-0.js";

describe("RunRenameInputSchema", () => {
  it("accepts a valid run_id and title", () => {
    const result = RunRenameInputSchema.safeParse({
      run_id: "run_123",
      title: "renamed"
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty title", () => {
    const result = RunRenameInputSchema.safeParse({
      run_id: "run_123",
      title: ""
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty run_id", () => {
    const result = RunRenameInputSchema.safeParse({
      run_id: "",
      title: "valid title"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a title longer than 160 characters", () => {
    const longTitle = "a".repeat(161);
    const result = RunRenameInputSchema.safeParse({
      run_id: "run_123",
      title: longTitle
    });
    expect(result.success).toBe(false);
  });

  it("accepts a title of exactly 160 characters", () => {
    const maxTitle = "a".repeat(160);
    const result = RunRenameInputSchema.safeParse({
      run_id: "run_123",
      title: maxTitle
    });
    expect(result.success).toBe(true);
  });
});

describe("RunRenamedPayloadSchema", () => {
  it("accepts a valid RUN_RENAMED event payload", () => {
    const result = RunRenamedPayloadSchema.safeParse({
      run_id: "run_abc",
      title: "new title",
      previous_title: "old title"
    });
    expect(result.success).toBe(true);
  });

  it("rejects payload missing previous_title", () => {
    const result = RunRenamedPayloadSchema.safeParse({
      run_id: "run_abc",
      title: "new title"
    });
    expect(result.success).toBe(false);
  });

  it("rejects payload with empty run_id", () => {
    const result = RunRenamedPayloadSchema.safeParse({
      run_id: "",
      title: "new title",
      previous_title: "old title"
    });
    expect(result.success).toBe(false);
  });
});
