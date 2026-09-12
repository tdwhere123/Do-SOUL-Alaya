import { describe, expect, it } from "vitest";
import {
  inspectJsonRecovery,
  parseOrRecoverJson
} from "../../../garden/extraction/pi-mono-json-recovery.js";

const truncated =
  '{"signals":[{"signal_kind":"potential_claim","object_kind":"u","confidence":0.5,"matched_text":"x"},';

describe("parseOrRecoverJson", () => {
  it("accepts strict JSON without recovery", () => {
    expect(parseOrRecoverJson('{"signals":[]}')).toEqual({
      rawJson: '{"signals":[]}',
      recoveryKind: "none"
    });
  });

  it("accepts markdown-fence recovery", () => {
    expect(parseOrRecoverJson('```json\n{"signals":[]}\n```')?.recoveryKind).toBe("markdown_strip");
  });

  it("accepts trailing-prose recovery", () => {
    expect(parseOrRecoverJson('{"signals":[]}\nNote: none.')?.recoveryKind).toBe("trailing_strip");
  });

  it("fail-closes truncated JSON that would need invented closers", () => {
    expect(parseOrRecoverJson(truncated)).toBeNull();
  });

  it("records balanced_close on inspection without treating it as success", () => {
    const inspected = inspectJsonRecovery(truncated);
    expect(inspected).toMatchObject({
      recoveryKind: "balanced_close",
      discardedCount: 1
    });
    expect(JSON.parse(inspected!.rawJson)).toEqual({
      signals: [{
        signal_kind: "potential_claim",
        object_kind: "u",
        confidence: 0.5,
        matched_text: "x"
      }]
    });
    expect(parseOrRecoverJson(truncated)).toBeNull();
  });

  it("allows balanced_close only when a caller opts in", () => {
    const recovered = parseOrRecoverJson(truncated, { allowBalancedClose: true });
    expect(recovered?.recoveryKind).toBe("balanced_close");
    expect(JSON.parse(recovered!.rawJson).signals).toHaveLength(1);
  });
});
