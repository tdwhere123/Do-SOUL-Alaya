import { describe, expect, it } from "vitest";
import {
  assertCaptureParityArmAuthority,
  type CaptureParityArmAuthority
} from "../../../longmemeval/capture-parity/authority.js";

const authority = {
  dataset_sha256: "a".repeat(64),
  question_id_digest: "b".repeat(64),
  runtime_attribution: { gate_eligible: true }
} as unknown as CaptureParityArmAuthority;

describe("capture parity arm authority", () => {
  it("accepts one common frozen authority", () => {
    expect(() => assertCaptureParityArmAuthority(authority, authority)).not.toThrow();
  });

  it.each([
    ["dataset", { dataset_sha256: "c".repeat(64) }],
    ["population", { question_id_digest: "d".repeat(64) }],
    ["runtime", { runtime_attribution: { gate_eligible: false } }]
  ] as const)("rejects %s drift", (_label, drift) => {
    const captureOn = { ...authority, ...drift } as unknown as CaptureParityArmAuthority;
    expect(() => assertCaptureParityArmAuthority(authority, captureOn))
      .toThrow(/arm authority differs/u);
  });
});
