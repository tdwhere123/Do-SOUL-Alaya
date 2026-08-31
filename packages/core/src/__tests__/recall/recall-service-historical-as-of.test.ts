import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";
import {
  requireLiveCandidateDiagnostics
} from "./fine-assessment-selection-fixtures.js";

const QUESTION_AS_OF = "2023-05-30T23:40:00.000Z";

describe("RecallService historical as-of generation miss", () => {
  it("completes with a sealed path axis instead of aborting", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-historical",
        content: "Use pnpm for workspace commands.",
        activation_score: 0.9
      })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      pathExpansionPort: {
        findByAnchors: vi.fn(async (_workspaceId, _anchors, options) => {
          if (options?.asOf === QUESTION_AS_OF) {
            throw generationMissingError();
          }
          return [];
        })
      },
      activeConstraintsPort: {
        findActiveConstraints: vi.fn(async ({ asOf }) => {
          if (asOf === QUESTION_AS_OF) {
            throw generationMissingError();
          }
          return { constraints: [], total_count: 0 };
        })
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      referenceTime: QUESTION_AS_OF,
      diagnosticCapture: "answer_features"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toContain("memory-historical");
    expect(result.active_constraints).toEqual([]);
    expect(result.active_constraints_count).toBe(0);
    const flood = requireLiveCandidateDiagnostics(result.diagnostics?.candidates ?? []).find(
      (candidate) => candidate.object_id === "memory-historical"
    )?.flood_potential;
    expect(flood?.path_status).toBe("inactive:index_unavailable");
  });
});

function generationMissingError(): Error {
  const error = new Error(
    `No verified temporal projection exists for as-of ${QUESTION_AS_OF}; rebuild it before recall.`
  );
  error.name = "TemporalProjectionGenerationMissingError";
  return error;
}
