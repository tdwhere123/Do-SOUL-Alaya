import { describe, expect, it } from "vitest";
import { AlayaError } from "@do-soul/alaya-protocol";
import { StorageError, isDuplicateKeyError } from "../../shared/errors.js";

describe("StorageError", () => {
  it("is an AlayaError", () => {
    const error = new StorageError("QUERY_FAILED", "Failed to query.");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AlayaError);
    expect(error).toBeInstanceOf(StorageError);
    expect(error.code).toBe("QUERY_FAILED");
    expect(error.name).toBe("StorageError");
  });

  it("accepts standard ErrorOptions cause like CoreError", () => {
    const cause = new Error("sqlite failed");
    const error = new StorageError("QUERY_FAILED", "Failed to query.", { cause });

    expect(error).toBeInstanceOf(StorageError);
    expect(error.cause).toBe(cause);
  });

  it("preserves the legacy third-argument cause shape", () => {
    const cause = new Error("sqlite failed");
    const error = new StorageError("QUERY_FAILED", "Failed to query.", cause);

    expect(error.cause).toBe(cause);
  });
});

describe("isDuplicateKeyError", () => {
  it("matches the structured DUPLICATE_KEY storage code", () => {
    expect(isDuplicateKeyError(new StorageError("DUPLICATE_KEY", "Garden task x already exists."))).toBe(true);
  });

  it("walks the cause chain and driver unique-constraint shapes", () => {
    const wrapped = new Error("enqueue failed", {
      cause: { code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: garden_tasks.id" }
    });
    expect(isDuplicateKeyError(wrapped)).toBe(true);
    expect(isDuplicateKeyError(new Error("UNIQUE constraint failed: garden_tasks.id"))).toBe(true);
    expect(isDuplicateKeyError(new Error("disk is full"))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});
