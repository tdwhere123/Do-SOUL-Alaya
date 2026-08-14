import { describe, expect, it, vi } from "vitest";
import { loadActiveConstraints } from "../../recall/runtime/orchestration.js";

const QUESTION_AS_OF = "2023-05-30T23:40:00.000Z";

describe("loadActiveConstraints path-index miss", () => {
  it.each([
    ["TemporalProjectionGenerationMissingError", generationMissingError()],
    ["LegacyPathIndexUnboundError", legacyUnboundError()]
  ] as const)("does not abort recall when the constraints port throws %s", async (_name, error) => {
    const warn = vi.fn();
    const result = await loadActiveConstraints({
      workspaceId: "workspace-1",
      cap: null,
      asOf: QUESTION_AS_OF,
      warn,
      activeConstraintsPort: {
        findActiveConstraints: vi.fn(async () => {
          throw error;
        })
      }
    });

    expect(result).toEqual({ constraints: [], total_count: 0 });
    expect(warn).toHaveBeenCalledWith(
      "active constraints lookup skipped",
      expect.objectContaining({
        workspace_id: "workspace-1",
        operation: "active_constraints",
        errorName: error.name,
        error: error.message
      })
    );
  });

  it("still throws a storage fault from the constraints port", async () => {
    const error = new Error("database disk image is malformed");
    error.name = "SqliteError";
    const warn = vi.fn();

    await expect(loadActiveConstraints({
      workspaceId: "workspace-1",
      cap: null,
      asOf: QUESTION_AS_OF,
      warn,
      activeConstraintsPort: {
        findActiveConstraints: vi.fn(async () => {
          throw error;
        })
      }
    })).rejects.toThrow(/malformed/);
    expect(warn).not.toHaveBeenCalled();
  });
});

function generationMissingError(): Error {
  const error = new Error(
    `No verified temporal projection exists for as-of ${QUESTION_AS_OF}; rebuild it before recall.`
  );
  error.name = "TemporalProjectionGenerationMissingError";
  return error;
}

function legacyUnboundError(): Error {
  const error = new Error(
    "Temporal path projection is populated but recall is bound to an empty legacy path_relations table."
  );
  error.name = "LegacyPathIndexUnboundError";
  return error;
}
