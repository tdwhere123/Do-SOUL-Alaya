import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "../../shared/sqlite-unique-constraint.js";

function sqliteError(input: {
  readonly code?: string;
  readonly message?: string;
  readonly cause?: unknown;
}): Error {
  return Object.assign(new Error(input.message ?? "sqlite error"), {
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.cause === undefined ? {} : { cause: input.cause })
  });
}

describe("isUniqueConstraintError", () => {
  it.each([
    {
      name: "UNIQUE extended code",
      error: sqliteError({
        code: "SQLITE_CONSTRAINT_UNIQUE",
        message: "UNIQUE constraint failed: garden_tasks.id"
      }),
      column: "garden_tasks.id",
      expected: true
    },
    {
      name: "UNIQUE message without extended code",
      error: sqliteError({ message: "UNIQUE constraint failed: workspaces.workspace_id" }),
      column: "workspaces.workspace_id",
      expected: true
    },
    {
      name: "CHECK constraint",
      error: sqliteError({
        code: "SQLITE_CONSTRAINT_CHECK",
        message: "CHECK constraint failed: memories"
      }),
      expected: false
    },
    {
      name: "NOT NULL constraint",
      error: sqliteError({
        code: "SQLITE_CONSTRAINT_NOTNULL",
        message: "NOT NULL constraint failed: memories.content"
      }),
      expected: false
    },
    {
      name: "FOREIGN KEY constraint",
      error: sqliteError({
        code: "SQLITE_CONSTRAINT_FOREIGNKEY",
        message: "FOREIGN KEY constraint failed"
      }),
      expected: false
    },
    {
      name: "cause-chain UNIQUE",
      error: new Error("wrapped", {
        cause: sqliteError({
          code: "SQLITE_CONSTRAINT_UNIQUE",
          message: "UNIQUE constraint failed: garden_tasks.id"
        })
      }),
      column: "garden_tasks.id",
      expected: true
    },
    {
      name: "custom application code",
      error: sqliteError({ code: "DUPLICATE_KEY", message: "already exists" }),
      expected: false
    },
    {
      name: "qualified column miss",
      error: sqliteError({
        code: "SQLITE_CONSTRAINT_UNIQUE",
        message: "UNIQUE constraint failed: garden_tasks.id"
      }),
      column: "workspaces.workspace_id",
      expected: false
    }
  ])("$name", ({ error, column, expected }) => {
    expect(isUniqueConstraintError(error, column)).toBe(expected);
  });

  it("does not follow causes beyond the bounded depth", () => {
    const unique = sqliteError({ code: "SQLITE_CONSTRAINT_UNIQUE" });
    const wrap = (inner: Error, count: number) =>
      Array.from({ length: count }).reduce<Error>((cause) => new Error("wrapped", { cause }), inner);
    expect(isUniqueConstraintError(wrap(unique, 4))).toBe(true);
    expect(isUniqueConstraintError(wrap(unique, 5))).toBe(false);
  });
});
