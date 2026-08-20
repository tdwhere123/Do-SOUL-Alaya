import { describe, expect, it } from "vitest";
import {
  EVIDENCE_ID,
  MEMORY_ID,
  createPlantedRecall,
  recallRequest
} from "./p217-planted-harness.js";
import {
  INDEX_ONLY_ID,
  LIVE_B_ID,
  UNBOUND_EVIDENCE_ID,
  createQueryOnlyHydrationHarness,
  fieldProjectionIds,
  selectWithUnboundEvidence
} from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("query-only hydration gap warnings", () => {
  it("warns selected-but-unbound and hydrated-but-dropped without a public trace field", async () => {
    const fixture = await hydration.openHydrationFixture();
    const warnings: Array<{ readonly message: string; readonly meta: Record<string, unknown> }> = [];
    const result = await createPlantedRecall({
      database: fixture.writer,
      field: {
        ...fixture.field,
        querySession: selectWithUnboundEvidence(fixture.field.querySession)
      },
      memoryRepo: fixture.dispatchedMemoryPort,
      extra: {
        warn: (message, meta) => {
          warnings.push({ message, meta });
        }
      }
    }).recall(recallRequest("Ada"));

    const trace = result.diagnostics?.field_projection_trace;
    expect(trace?.candidate_keys).toEqual([EVIDENCE_ID, UNBOUND_EVIDENCE_ID]);
    expect(fieldProjectionIds(result)).toEqual([MEMORY_ID, LIVE_B_ID]);
    expect(trace).not.toHaveProperty("selected_but_unbound");
    expect(trace).not.toHaveProperty("hydrated_but_dropped");
    expect(warnings).toEqual([
      {
        message: "field projection selected evidence has no hydrated JSON binding",
        meta: { selected_but_unbound: [UNBOUND_EVIDENCE_ID] }
      },
      {
        message: "field projection hydrated memory omitted by JSON activation binding",
        meta: { hydrated_but_dropped: [INDEX_ONLY_ID] }
      }
    ]);
  });
});
