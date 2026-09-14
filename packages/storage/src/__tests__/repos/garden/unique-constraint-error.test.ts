import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "@do-soul/alaya-protocol";
import { isUniqueConstraintError as storageReexport } from "../../../repos/garden/garden-task-errors.js";

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
    expect(storageReexport(error, column)).toBe(expected);
  });

  it("is the protocol owner re-exported by storage", () => {
    expect(storageReexport).toBe(isUniqueConstraintError);
  });
});
