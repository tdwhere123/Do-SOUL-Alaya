import { describe, expect, it, vi } from "vitest";
import { loadActiveConstraints } from "../../recall/runtime/orchestration.js";

const QUESTION_AS_OF = "2023-05-30T23:40:00.000Z";

describe("loadActiveConstraints path-index miss", () => {
  it("does not abort recall when the historical projection generation is missing", async () => {
    const result = await loadActiveConstraints({
      workspaceId: "workspace-1",
      cap: null,
      asOf: QUESTION_AS_OF,
      activeConstraintsPort: {
        findActiveConstraints: vi.fn(async () => {
          throw generationMissingError();
        })
      }
    });

    expect(result).toEqual({ constraints: [], total_count: 0 });
  });

  it("still throws a storage fault from the constraints port", async () => {
    const error = new Error("database disk image is malformed");
    error.name = "SqliteError";

    await expect(loadActiveConstraints({
      workspaceId: "workspace-1",
      cap: null,
      asOf: QUESTION_AS_OF,
      activeConstraintsPort: {
        findActiveConstraints: vi.fn(async () => {
          throw error;
        })
      }
    })).rejects.toThrow(/malformed/);
  });
});

function generationMissingError(): Error {
  const error = new Error(
    `No verified temporal projection exists for as-of ${QUESTION_AS_OF}; rebuild it before recall.`
  );
  error.name = "TemporalProjectionGenerationMissingError";
  return error;
}
