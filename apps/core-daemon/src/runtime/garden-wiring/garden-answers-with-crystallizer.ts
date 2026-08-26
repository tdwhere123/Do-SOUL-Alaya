import {
  AnswersWithEdgeProducerService,
  HqAnswerOverlapPairSource,
  type RelationAssertionAdmissionPort
} from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createOptionalMemoryHqRepo } from "../daemon/lifecycle/daemon-runtime-support.js";

type Warn = (message: string, meta: Record<string, unknown>) => void;

export function createAnswersWithCrystallizer(input: {
  readonly database: StorageDatabase;
  readonly relationAssertionAdmissionPort: RelationAssertionAdmissionPort;
  readonly warn: Warn;
}): AnswersWithEdgeProducerService | undefined {
  const hqRepo = createOptionalMemoryHqRepo(input.database);
  if (hqRepo === null) {
    return undefined;
  }
  return new AnswersWithEdgeProducerService({
    pairSource: new HqAnswerOverlapPairSource(hqRepo),
    assertionPort: input.relationAssertionAdmissionPort,
    warn: input.warn
  });
}
