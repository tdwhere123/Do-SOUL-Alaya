import {
  ControlPlaneObjectKind,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";

export const ACTIVE_STATE = "active";

export interface GardenDataPortFactoryContext {
  readonly database: StorageDatabase;
  readonly now: () => string;
  readonly generateId: () => string;
}

interface CandidateProposalInput {
  readonly workspaceId: string;
  readonly derivedFrom: string;
  readonly dossierRef: string;
  readonly droppedCandidates?: readonly string[];
  readonly unresolvedAfterApply?: readonly string[];
}

export function createPendingCandidateProposal(context: GardenDataPortFactoryContext, input: CandidateProposalInput): string {
  const proposalId = context.generateId();
  const runtimeId = context.generateId();
  const optionId = context.generateId();
  const nowIso = context.now();
  const proposalOptions = JSON.stringify([
    {
      option_id: optionId,
      option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
      preserves_protected_constraints: true,
      dropped_candidates: [...(input.droppedCandidates ?? [])],
      unresolved_after_apply: [...(input.unresolvedAfterApply ?? [])],
      requires_confirmation: true
    }
  ]);

  context.database.connection
    .prepare(
      `INSERT INTO proposals (
        runtime_id,
        object_kind,
        proposal_id,
        task_surface_ref,
        derived_from,
        retention_policy,
        dossier_ref,
        recommended_option_id,
        proposal_options,
        resolution_state,
        expires_at,
        last_updated_at,
        workspace_id,
        run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runtimeId,
      ControlPlaneObjectKind.PROPOSAL,
      proposalId,
      null,
      input.derivedFrom,
      RetentionPolicy.RUN_SCOPED,
      input.dossierRef,
      optionId,
      proposalOptions,
      ProposalResolutionState.PENDING,
      null,
      nowIso,
      input.workspaceId,
      null
    );

  return proposalId;
}

export function addMilliseconds(isoTimestamp: string, deltaMs: number): string {
  const base = Date.parse(isoTimestamp);
  if (Number.isNaN(base)) {
    return new Date(deltaMs).toISOString();
  }
  return new Date(base + deltaMs).toISOString();
}

export function buildDerivedKey(prefix: string, value: string): string {
  return `${prefix}:${value}`;
}