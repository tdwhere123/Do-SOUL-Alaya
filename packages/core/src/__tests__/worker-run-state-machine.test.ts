import { describe, expect, it } from "vitest";
import type { WorkerRunState } from "@do-soul/alaya-protocol";
import { CoreError } from "../errors.js";
import { assertWorkerTransition } from "../worker-run-state-machine.js";

describe("assertWorkerTransition", () => {
  it("accepts every legal transition from the A1-3 state graph", () => {
    const legalTransitions: ReadonlyArray<readonly [WorkerRunState, WorkerRunState]> = [
      ["init", "active"],
      ["init", "frozen"],
      ["active", "completed"],
      ["active", "suspended"],
      ["active", "aborted"],
      ["active", "frozen"],
      ["suspended", "active"],
      ["suspended", "aborted"],
      ["suspended", "frozen"],
      ["completed", "frozen"],
      ["aborted", "frozen"]
    ];

    for (const [from, to] of legalTransitions) {
      expect(() => assertWorkerTransition(from, to)).not.toThrow();
    }
  });

  it("rejects illegal transitions", () => {
    const illegalTransitions: ReadonlyArray<readonly [WorkerRunState, WorkerRunState]> = [
      ["init", "completed"],
      ["init", "aborted"],
      ["completed", "active"],
      ["aborted", "active"],
      ["frozen", "active"],
      ["frozen", "frozen"]
    ];

    for (const [from, to] of illegalTransitions) {
      expect(() => assertWorkerTransition(from, to)).toThrowError(CoreError);
      expect(() => assertWorkerTransition(from, to)).toThrowError(
        `Illegal worker state transition: ${from} -> ${to}`
      );
    }
  });
});
