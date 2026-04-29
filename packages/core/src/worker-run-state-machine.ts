import { WorkerRunStateSchema, type WorkerRunState } from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";

const ALLOWED_TRANSITIONS: Readonly<Record<WorkerRunState, readonly WorkerRunState[]>> = {
  init: ["active", "frozen"],
  active: ["completed", "suspended", "aborted", "frozen"],
  suspended: ["active", "aborted", "frozen"],
  completed: ["frozen"],
  aborted: ["frozen"],
  frozen: []
};

export function assertWorkerTransition(from: WorkerRunState, to: WorkerRunState): void {
  const parsedFrom = WorkerRunStateSchema.parse(from);
  const parsedTo = WorkerRunStateSchema.parse(to);

  if (!ALLOWED_TRANSITIONS[parsedFrom].includes(parsedTo)) {
    throw new CoreError(
      "VALIDATION",
      `Illegal worker state transition: ${parsedFrom} -> ${parsedTo}`
    );
  }
}
