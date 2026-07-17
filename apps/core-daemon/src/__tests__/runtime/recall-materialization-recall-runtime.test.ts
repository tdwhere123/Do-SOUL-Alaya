import { describe, expect, it, vi } from "vitest";
import { createRecallPathReadPorts } from "../../runtime/recall-path-readers.js";
import { createRecallActiveConstraintsPort } from "../../runtime/recall-materialization-recall-runtime.js";

const workspaceId = "workspace-active-constraints";

describe("createRecallActiveConstraintsPort", () => {
  it("uses the selected current or historical projection that the recall requested", async () => {
    const temporalReader = {
      findByAnchors: vi.fn(async () => []),
      findByTimeConcernWindowDigests: vi.fn(async () => []),
      findByWorkspace: vi.fn(async () => [])
    };
    const ensureTemporalProjection = vi.fn(async () => undefined);
    const paths = createRecallPathReadPorts({
      temporalProjectionSelected: true,
      temporalPathProjectionReader: temporalReader,
      ensureTemporalProjection
    });
    const activeConstraints = createRecallActiveConstraintsPort({
      memoryEntryRepo: { findByIds: vi.fn(async () => []) },
      claimFormRepo: { findByStatus: vi.fn(async () => []) }
    }, paths);
    const asOf = "2026-07-17T01:30:00.000Z";

    await activeConstraints.findActiveConstraints({ workspaceId, asOf });

    expect(temporalReader.findByWorkspace).toHaveBeenCalledWith(workspaceId, { asOf });
    expect(ensureTemporalProjection).toHaveBeenCalledWith({ asOf });

    await activeConstraints.findActiveConstraints({ workspaceId });

    expect(temporalReader.findByWorkspace).toHaveBeenLastCalledWith(workspaceId, {});
    expect(ensureTemporalProjection).toHaveBeenLastCalledWith({});
  });
});
