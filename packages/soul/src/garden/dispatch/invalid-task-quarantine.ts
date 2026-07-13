import type { GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import { parseTaskDescriptorFromRow } from "../scheduler-helpers.js";
import type {
  GardenTaskRepoPort,
  GardenTaskRow
} from "../scheduler-types.js";
import { buildTaskFailureCompletionEvent } from "./task-failure-completion-event.js";

interface InvalidTaskQuarantinePorts {
  readonly taskRepo: GardenTaskRepoPort;
  readonly onQuarantined: () => void;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export async function readDispatchTask(
  candidate: GardenTaskRow,
  nowIso: string,
  ports: InvalidTaskQuarantinePorts
): Promise<GardenTaskDescriptor | null> {
  try {
    return parseTaskDescriptorFromRow(candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await quarantineInvalidTask(candidate, reason, nowIso, ports);
    return null;
  }
}

export async function quarantineInvalidTask(
  candidate: GardenTaskRow,
  reason: string,
  nowIso: string,
  ports: InvalidTaskQuarantinePorts
): Promise<void> {
  const quarantined = await ports.taskRepo.failPendingWithCompletionEvent(
    candidate.id,
    nowIso,
    reason,
    buildTaskFailureCompletionEvent(candidate, nowIso)
  );
  if (!quarantined) return;
  ports.onQuarantined();
  ports.warn("[garden] invalid in-process task quarantined", {
    taskId: candidate.id,
    kind: candidate.kind,
    reason
  });
}
