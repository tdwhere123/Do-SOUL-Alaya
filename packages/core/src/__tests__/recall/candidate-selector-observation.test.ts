import { describe, expect, it, vi } from "vitest";
import { collectGovernancePathDerivations } from "../../recall/supplements/supplementary-data-governance-paths.js";
import { LegacyPathIndexUnboundError } from "../../recall/runtime/legacy-path-index-unbound-error.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("governance path lookup availability", () => {
  it("marks an unbound legacy Path index as unavailable", async () => {
    const memory = createMemoryEntry({ object_id: "memory-1" });
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw new LegacyPathIndexUnboundError();
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [memory]
    });

    expect(result.pathInflowAvailability).toBe("unavailable");
  });

  it("marks a reconstructed unbound error by name after worker serialization", async () => {
    const memory = createMemoryEntry({ object_id: "memory-1" });
    const serialized = new Error("Temporal path projection is populated but recall is bound to an empty legacy path_relations table.");
    serialized.name = "LegacyPathIndexUnboundError";
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw serialized;
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [memory]
    });

    expect(result.pathInflowAvailability).toBe("unavailable");
  });

  it("marks a missing historical projection generation as unavailable, not storage_error", async () => {
    const memory = createMemoryEntry({ object_id: "memory-1" });
    const missing = new Error(
      "No verified temporal projection exists for as-of 2023-05-30T23:40:00.000Z; rebuild it before recall."
    );
    missing.name = "TemporalProjectionGenerationMissingError";
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw missing;
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      pathProjectionAsOf: "2023-05-30T23:40:00.000Z",
      candidates: [memory]
    });

    expect(result.pathInflowAvailability).toBe("unavailable");
  });

  it("marks a path-index storage fault as storage_error instead of unavailable", async () => {
    const memory = createMemoryEntry({ object_id: "memory-1" });
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw new Error("path store unavailable");
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [memory]
    });

    expect(result.pathInflowAvailability).toBe("storage_error");
  });
});
