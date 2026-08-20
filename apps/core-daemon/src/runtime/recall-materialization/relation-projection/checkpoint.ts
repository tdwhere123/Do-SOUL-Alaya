import type {
  RelationAssertionAdmissionPort,
  RelationAssertionService
} from "@do-soul/alaya-core";
import type { RelationProjectionAdmissionMode } from "./mode.js";

export interface RelationProjectionCheckpointPort {
  refresh(): Promise<boolean>;
}

export function createRelationProjectionModePorts(
  service: RelationAssertionService,
  mode: RelationProjectionAdmissionMode
): Readonly<{
  readonly relationAssertionAdmissionPort: RelationAssertionAdmissionPort;
  readonly relationProjectionCheckpoint: RelationProjectionCheckpointPort;
}> {
  if (mode === "immediate") {
    return Object.freeze({
      relationAssertionAdmissionPort: { admit: (request) => service.admit(request) },
      relationProjectionCheckpoint: { refresh: async () => false }
    });
  }
  return Object.freeze({
    relationAssertionAdmissionPort: {
      admit: (request) => service.admitDeferredProjection(request)
    },
    relationProjectionCheckpoint: {
      refresh: async () => {
        await service.refreshProjection();
        return true;
      }
    }
  });
}
