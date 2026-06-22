import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "../../shared/event-utils.js";

describe("isUniqueConstraintError", () => {
  it("returns true when the cause message reports a unique-constraint failure", () => {
    const error = new Error("wrapped", {
      cause: new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: events.id")
    });
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  it("returns true when the driver exposes the extended unique constraint code", () => {
    const error = new Error("wrapped", {
      cause: Object.assign(new Error("driver text changed"), {
        code: "SQLITE_CONSTRAINT_UNIQUE"
      })
    });
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  it("returns true when the driver exposes SQLite constraint errno", () => {
    const error = new Error("wrapped", {
      cause: Object.assign(new Error("driver text changed"), {
        errno: 19
      })
    });
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  it("returns false for an unrelated cause message", () => {
    const error = new Error("wrapped", { cause: new Error("disk full") });
    expect(isUniqueConstraintError(error)).toBe(false);
  });

  it("returns false for an error without a cause", () => {
    expect(isUniqueConstraintError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError("UNIQUE constraint failed")).toBe(false);
  });
});
