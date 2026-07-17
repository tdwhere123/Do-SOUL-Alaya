import { describe, expect, it } from "vitest";
import { auditOfficialApiSignalFormation } from "@do-soul/alaya-soul";

const CREATED_AT = "2026-07-17T00:00:00.000Z";
const SOURCE_OBSERVED_AT = "2026-07-16T12:00:00.000Z";

const validSignal = {
  signal_kind: "potential_claim",
  object_kind: "decision",
  confidence: 0.7,
  matched_text: "We decided to ship on Friday."
};

function auditInput(overrides: Partial<Parameters<typeof auditOfficialApiSignalFormation>[0]> = {}) {
  return {
    raw_json: JSON.stringify({ signals: [validSignal, {}] }),
    turn_content: "We decided to ship on Friday.",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    created_at: CREATED_AT,
    source_observed_at: SOURCE_OBSERVED_AT,
    signal_id_for: (index: number) => `audit-${index}`,
    ...overrides
  };
}

describe("auditOfficialApiSignalFormation", () => {
  it("accounts for every strict-envelope element through a terminal disposition", () => {
    const result = auditOfficialApiSignalFormation(auditInput());

    expect(result.mode).toBe("strict");
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      index: 0,
      disposition: "admitted",
      stage: "formation",
      reason: "formed",
      signal: {
        signal_id: "audit-0",
        created_at: CREATED_AT
      }
    });
    expect(result.entries[1]).toEqual({
      index: 1,
      disposition: "invalid",
      stage: "parse",
      reason: "entry_schema_invalid"
    });
  });

  it("uses salvage accounting when the envelope is malformed but complete elements remain", () => {
    const malformedEnvelope =
      `{"signals":[${JSON.stringify(validSignal)},${JSON.stringify({ signal_kind: "unsupported" })}`;

    const result = auditOfficialApiSignalFormation(auditInput({ raw_json: malformedEnvelope }));

    expect(result.mode).toBe("salvage");
    expect(result.entries).toMatchObject([
      { index: 0, disposition: "admitted", stage: "formation", reason: "formed" },
      { index: 1, disposition: "invalid", stage: "parse", reason: "entry_schema_invalid" }
    ]);
  });

  it("accounts for a truncated salvage element instead of silently omitting it", () => {
    const malformedEnvelope =
      `{"signals":[${JSON.stringify(validSignal)},{"signal_kind":"potential_claim"`;

    const result = auditOfficialApiSignalFormation(auditInput({ raw_json: malformedEnvelope }));

    expect(result.entries).toMatchObject([
      { index: 0, disposition: "admitted", stage: "formation", reason: "formed" },
      { index: 1, disposition: "invalid", stage: "parse", reason: "salvage_element_truncated" }
    ]);
  });

  it("defers strict-envelope elements outside the production 64-signal cap", () => {
    const raw_json = JSON.stringify({
      signals: Array.from({ length: 65 }, () => validSignal)
    });

    const result = auditOfficialApiSignalFormation(auditInput({ raw_json }));

    expect(result.entries).toHaveLength(65);
    expect(result.entries[63]).toMatchObject({ disposition: "admitted", reason: "formed" });
    expect(result.entries[64]).toEqual({
      index: 64,
      disposition: "deferred",
      stage: "parse",
      reason: "signal_limit_exceeded"
    });
  });

  it("defers parsed elements when C0 requires source observation rather than inventing now", () => {
    const { source_observed_at: _sourceObservedAt, ...withoutSourceObservation } = auditInput({
      raw_json: JSON.stringify({ signals: [validSignal] })
    });

    const result = auditOfficialApiSignalFormation({
      ...withoutSourceObservation,
      require_source_observed_at: true
    });

    expect(result.entries).toEqual([
      {
        index: 0,
        disposition: "deferred",
        stage: "source_observation",
        reason: "source_observed_at_missing"
      }
    ]);
  });

  it("reports ungrounded parsed elements as rejected", () => {
    const result = auditOfficialApiSignalFormation(auditInput({
      raw_json: JSON.stringify({
        signals: [{ ...validSignal, matched_text: "Call me Ash." }]
      })
    }));

    expect(result.entries[0]).toMatchObject({
      index: 0,
      disposition: "rejected",
      stage: "grounding",
      reason: expect.any(String)
    });
  });
});
