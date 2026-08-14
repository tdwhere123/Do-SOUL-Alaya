import { isDeepStrictEqual } from "node:util";
import type { RecallEvalRunContext } from
  "../lifecycle/recall-eval/recall-eval-run-context.js";

export type CaptureParityArmAuthority = Readonly<{
  dataset_sha256: string | null;
  question_id_digest: string;
  runtime_attribution: RecallEvalRunContext["runtimeAttribution"];
}>;

export function assertCaptureParityArmAuthority(
  captureOff: CaptureParityArmAuthority,
  captureOn: CaptureParityArmAuthority
): void {
  if (!isDeepStrictEqual(captureOff, captureOn)) {
    throw new Error("capture parity arm authority differs");
  }
}
