import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export const ACTIVE_STATE = "active";

export interface GardenProposalWriter {
  create(input: Readonly<{
    workspaceId: string; derivedFrom: string; dossierRef: string; causedBy: string;
    droppedCandidates?: readonly string[]; unresolvedAfterApply?: readonly string[];
  }>): Promise<{ readonly candidate_id: string; readonly created: boolean }>;
}

export interface GardenDataPortFactoryContext {
  readonly database: StorageDatabase;
  readonly now: () => string;
  readonly proposalWriter?: GardenProposalWriter;
}

export async function createPendingCandidateProposal(
  context: GardenDataPortFactoryContext, input: Parameters<GardenProposalWriter["create"]>[0]
): Promise<{ readonly candidate_id: string; readonly created: boolean }> {
  if (context.proposalWriter === undefined) {
    throw new StorageError("VALIDATION_FAILED", "Garden proposal creation owner is unavailable.");
  }
  return await context.proposalWriter.create(input);
}

export function addMilliseconds(isoTimestamp: string, deltaMs: number): string {
  const base = Date.parse(isoTimestamp);
  if (Number.isNaN(base)) return new Date(deltaMs).toISOString();
  return new Date(base + deltaMs).toISOString();
}

export function buildDerivedKey(prefix: string, value: string): string {
  return `${prefix}:${value}`;
}
