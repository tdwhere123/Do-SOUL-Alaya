import { randomUUID } from "node:crypto";
import {
  buildMemorySearchRecallPolicy,
  buildRecallPolicy as buildRecallPolicyCore
} from "@do-soul/alaya-core";
import type { RecallPolicy } from "@do-soul/alaya-protocol";

export function buildBenchDiagnosticRecallPolicy(
  taskSurfaceId: string,
  maxResultsInput: number,
  conflictAwareness = true
): RecallPolicy {
  const maxResults = Math.max(maxResultsInput, 1);
  const productInput = {
    runtimeId: randomUUID(),
    taskSurfaceId,
    maxResults,
    filters: {
      scopeFilter: null,
      dimensionFilter: null,
      domainTagFilter: null
    }
  } as const;
  if (conflictAwareness) {
    return buildMemorySearchRecallPolicy(productInput);
  }
  return buildRecallPolicyCore({
    ...productInput,
    conflictAwareness,
    maxTotalTokens: 2_000,
    coarseFloor: 0
  });
}
