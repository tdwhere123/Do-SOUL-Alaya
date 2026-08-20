import {
  PrivacyEraseReasonCodeSchema,
  type MemoryEntryMutableFields,
  type MemoryProposalOperation,
  type SoulProposeMemoryUpdateRequest
} from "@do-soul/alaya-protocol";

export type PreparedMemoryProposalOperation = Readonly<{
  readonly operation: MemoryProposalOperation;
  readonly targetObjectKind: "memory_entry" | "source_record";
  readonly proposedChanges: Readonly<MemoryEntryMutableFields> | null;
  readonly targetBaselineUpdatedAt: string | null;
}>;

export async function prepareMemoryProposalOperation(
  request: SoulProposeMemoryUpdateRequest,
  readTargetBaseline: () => Promise<string | null>,
  invalidRequest: (message: string) => Error
): Promise<PreparedMemoryProposalOperation> {
  if (request.operation === "privacy_erase") {
    PrivacyEraseReasonCodeSchema.parse(request.reason);
    return {
      operation: "privacy_erase",
      targetObjectKind: "source_record",
      proposedChanges: null,
      targetBaselineUpdatedAt: null
    };
  }
  if (request.proposed_changes === undefined) {
    throw invalidRequest("Memory update proposal requires proposed_changes.");
  }
  return {
    operation: "memory_update",
    targetObjectKind: "memory_entry",
    proposedChanges: request.proposed_changes,
    targetBaselineUpdatedAt: await readTargetBaseline()
  };
}
