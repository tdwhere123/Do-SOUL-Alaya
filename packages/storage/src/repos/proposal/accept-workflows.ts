import {
  GreenGovernanceEventType,
  MemoryGovernanceEventType,
  PathGovernanceClass,
  RevokeReason,
  RuntimeGovernanceEventType,
  SoulGreenPiercedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  SoulSynthesisCreatedPayloadSchema,
  parseRuntimeGovernanceEventPayload,
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type Proposal,
  type ProposalResolutionState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../db.js";
import { StorageError } from "../../errors.js";
import { parseMemoryEntryRow, type MemoryEntryRow } from "../memory-entry/row-mapper.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { insertEventLogEntry } from "../shared/event-log-writer.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  applyPathRelationProposal,
  createPathRelationFromProposalPayload,
  createStrictlyGovernedPathRelation,
  parseProposedPathRelation,
  parseProposalPathRelationRow,
  pathRelationMatchesProposalPayload
} from "./path-relations.js";
import {
  assertAcceptedMemoryUpdateMatchesProposal,
  assertAcceptedPathRelationGovernanceMatchesProposal,
  assertAcceptedSynthesisCreateMatchesProposal,
  parseAcceptedMemoryUpdateInput,
  parseAcceptedPathRelationGovernanceInput,
  parseAcceptedSynthesisCreateInput,
  shouldRevokeGreenForEvidenceRewrite,
  toUpdatedFieldNames
} from "./acceptance.js";
import { parseProposalId, parseProposalRow, parseUpdatedAt } from "./mappers.js";
import type {
  AcceptedMemoryUpdateInput,
  AcceptedPathRelationGovernanceInput,
  AcceptedSynthesisCreateInput,
  ProposalResolutionEventInput,
  UpdatePendingResolutionOptions
} from "./types.js";
import type {
  ProposalPathRelationRow,
  ProposalRow,
  RevokableGreenStatusRow
} from "./rows.js";

interface SqliteStatement {
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

export interface SqliteProposalWorkflowContext {
  readonly db: StorageDatabase;
  readonly eventLogWriter: Parameters<typeof insertEventLogEntry>[0];
  readonly findByIdStatement: SqliteStatement;
  readonly findMemoryEntryByIdStatement: SqliteStatement;
  readonly updateMemoryEntryStatement: SqliteStatement;
  readonly findRevokableGreenStatusStatement: SqliteStatement;
  readonly revokeGreenStatusStatement: SqliteStatement;
  readonly updatePendingResolutionStatement: SqliteStatement;
  readonly updatePendingResolutionWithIdentityStatement: SqliteStatement;
  readonly findPathRelationByAnchorMemoryIdStatement: SqliteStatement;
  readonly createPathRelationStatement: SqliteStatement;
  readonly updatePathRelationLegitimacyStatement: SqliteStatement;
  readonly createSynthesisCapsuleStatement: SqliteStatement;
  readonly createPendingResolutionFailure: (proposalId: string) => StorageError;
}

export async function acceptPendingMemoryUpdateWithEvents(
  ctx: SqliteProposalWorkflowContext,
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    memoryUpdate: AcceptedMemoryUpdateInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly memory: Readonly<MemoryEntry>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
    const parsedMemoryUpdate = parseAcceptedMemoryUpdateInput(memoryUpdate);

    try {
      return ctx.db.connection.transaction(() => {
        const proposalRow = ctx.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (proposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }
        if (proposalRow.resolution_state !== "pending") {
          throw ctx.createPendingResolutionFailure(parsedProposalId);
        }
        assertAcceptedMemoryUpdateMatchesProposal(proposalRow, parsedMemoryUpdate);

        const existingMemoryRow = ctx.findMemoryEntryByIdStatement.get(
          parsedMemoryUpdate.target_object_id
        ) as MemoryEntryRow | undefined;
        if (existingMemoryRow === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found.`
          );
        }
        const existingMemory = parseMemoryEntryRow(existingMemoryRow);
        if (existingMemory.workspace_id !== parsedMemoryUpdate.workspace_id) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found in workspace ${parsedMemoryUpdate.workspace_id}.`
          );
        }
        if (existingMemory.lifecycle_state === "archived") {
          throw new StorageError(
            "VALIDATION_FAILED",
            `Memory entry ${parsedMemoryUpdate.target_object_id} is archived and cannot be updated.`
          );
        }

        // Cross-proposal lost-update guard. The workflow captured the
        // memory's updated_at outside this transaction; if the live row
        // has moved on because a sibling proposal already committed
        // against the same memory entry, abort with CONFLICT so the
        // reviewer can re-review against the new baseline.
        if (
          parsedMemoryUpdate.expected_baseline_updated_at !== null &&
          existingMemory.updated_at !== parsedMemoryUpdate.expected_baseline_updated_at
        ) {
          throw new StorageError(
            "CONFLICT",
            `Memory entry ${parsedMemoryUpdate.target_object_id}: proposal was made against a stale snapshot; re-review required.`
          );
        }

        const storedReviewEvents = events.map((event) => insertEventLogEntry(ctx.eventLogWriter, event));
        const acceptedState = "accepted" satisfies ProposalResolutionState;
        const result =
          reviewerIdentity === undefined
            ? ctx.updatePendingResolutionStatement.run(
                acceptedState,
                parsedUpdatedAt,
                parsedProposalId
              )
            : ctx.updatePendingResolutionWithIdentityStatement.run(
                acceptedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw ctx.createPendingResolutionFailure(parsedProposalId);
        }

        const parsedFields = parsedMemoryUpdate.proposed_changes;
        const memoryEvent = insertEventLogEntry(ctx.eventLogWriter, {
          event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
          entity_type: "memory_entry",
          entity_id: existingMemory.object_id,
          workspace_id: existingMemory.workspace_id,
          run_id: existingMemory.run_id,
          caused_by: parsedMemoryUpdate.caused_by,
          payload_json: SoulMemoryUpdatedPayloadSchema.parse({
            object_id: existingMemory.object_id,
            object_kind: existingMemory.object_kind,
            workspace_id: existingMemory.workspace_id,
            run_id: existingMemory.run_id,
            updated_fields: toUpdatedFieldNames(parsedMemoryUpdate.proposed_changes)
          })
        });
        const revokableGreenStatus =
          parsedFields.evidence_refs !== undefined &&
          shouldRevokeGreenForEvidenceRewrite(existingMemory.evidence_refs, parsedFields.evidence_refs)
            ? (ctx.findRevokableGreenStatusStatement.get(
                existingMemory.object_id,
                existingMemory.workspace_id
              ) as RevokableGreenStatusRow | undefined)
            : undefined;
        const greenEvent =
          revokableGreenStatus === undefined
            ? undefined
            : insertEventLogEntry(ctx.eventLogWriter, {
                event_type: GreenGovernanceEventType.SOUL_GREEN_PIERCED,
                entity_type: "green_status",
                entity_id: revokableGreenStatus.object_id,
                workspace_id: existingMemory.workspace_id,
                run_id: existingMemory.run_id,
                caused_by: parsedMemoryUpdate.caused_by,
                payload_json: SoulGreenPiercedPayloadSchema.parse({
                  object_id: revokableGreenStatus.object_id,
                  target_object_id: existingMemory.object_id,
                  revoke_reason: RevokeReason.MAPPING_REVOKED,
                  workspace_id: existingMemory.workspace_id,
                  occurred_at: parsedUpdatedAt
                })
              });
        const memoryResult = ctx.updateMemoryEntryStatement.run(
          parsedFields.content ?? null,
          parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
          parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
          parsedFields.storage_tier ?? null,
          parsedFields.confidence ?? null,
          parsedFields.retention_state ?? null,
          parsedFields.updated_at,
          parsedMemoryUpdate.target_object_id
        );
        if (memoryResult.changes === 0) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found during update.`
          );
        }
        if (revokableGreenStatus !== undefined) {
          const greenResult = ctx.revokeGreenStatusStatement.run(
            RevokeReason.MAPPING_REVOKED,
            parsedUpdatedAt,
            parsedUpdatedAt,
            revokableGreenStatus.object_id,
            existingMemory.object_id,
            existingMemory.workspace_id
          );
          if (greenResult.changes === 0) {
            throw new StorageError(
              "CONFLICT",
              `Green status ${revokableGreenStatus.object_id} was not revokable during memory update.`
            );
          }
        }

        const updatedMemoryRow = ctx.findMemoryEntryByIdStatement.get(
          parsedMemoryUpdate.target_object_id
        ) as MemoryEntryRow | undefined;
        if (updatedMemoryRow === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found after update.`
          );
        }
        const updatedMemory = parseMemoryEntryRow(updatedMemoryRow);

        const updatedProposalRow = ctx.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (updatedProposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(updatedProposalRow),
          memory: updatedMemory,
          events: greenEvent === undefined
            ? [...storedReviewEvents, memoryEvent]
            : [...storedReviewEvents, memoryEvent, greenEvent]
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to accept proposal ${parsedProposalId} with durable memory update.`,
        error
      );
    }
  }

export async function acceptPendingPathRelationGovernanceWithEvents(
  ctx: SqliteProposalWorkflowContext,
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    pathRelationGovernance: AcceptedPathRelationGovernanceInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly path_relation: Readonly<PathRelation>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
    const parsedPathRelationGovernance = parseAcceptedPathRelationGovernanceInput(
      pathRelationGovernance
    );

    try {
      return ctx.db.connection.transaction(() => {
        const proposalRow = ctx.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (proposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }
        if (proposalRow.resolution_state !== "pending") {
          throw ctx.createPendingResolutionFailure(parsedProposalId);
        }
        assertAcceptedPathRelationGovernanceMatchesProposal(
          proposalRow,
          parsedPathRelationGovernance
        );

        const memoryRow = ctx.findMemoryEntryByIdStatement.get(
          parsedPathRelationGovernance.target_object_id
        ) as MemoryEntryRow | undefined;
        if (memoryRow === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedPathRelationGovernance.target_object_id} was not found.`
          );
        }
        const memory = parseMemoryEntryRow(memoryRow);
        if (memory.workspace_id !== parsedPathRelationGovernance.workspace_id) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedPathRelationGovernance.target_object_id} was not found in workspace ${parsedPathRelationGovernance.workspace_id}.`
          );
        }

        const storedReviewEvents = events.map((event) => insertEventLogEntry(ctx.eventLogWriter, event));
        const acceptedState = "accepted" satisfies ProposalResolutionState;
        const result =
          reviewerIdentity === undefined
            ? ctx.updatePendingResolutionStatement.run(
                acceptedState,
                parsedUpdatedAt,
                parsedProposalId
              )
            : ctx.updatePendingResolutionWithIdentityStatement.run(
                acceptedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw ctx.createPendingResolutionFailure(parsedProposalId);
        }

        const pathApply = upsertStrictlyGovernedPathRelation(
          ctx,
          parsedPathRelationGovernance,
          proposalRow
        );

        const updatedProposalRow = ctx.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (updatedProposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(updatedProposalRow),
          path_relation: pathApply.pathRelation,
          events:
            pathApply.event === null
              ? storedReviewEvents
              : [...storedReviewEvents, pathApply.event]
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to accept proposal ${parsedProposalId} with durable path relation governance update.`,
        error
      );
    }
  }

export async function acceptPendingSynthesisCreateWithEvents(
  ctx: SqliteProposalWorkflowContext,
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    synthesisCreate: AcceptedSynthesisCreateInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly synthesis: Readonly<SynthesisCapsule>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
    const parsedSynthesisCreate = parseAcceptedSynthesisCreateInput(synthesisCreate);

    try {
      return ctx.db.connection.transaction(() => {
        const proposalRow = ctx.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (proposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }
        if (proposalRow.resolution_state !== "pending") {
          throw ctx.createPendingResolutionFailure(parsedProposalId);
        }
        assertAcceptedSynthesisCreateMatchesProposal(proposalRow, parsedSynthesisCreate);

        const storedReviewEvents = events.map((event) => insertEventLogEntry(ctx.eventLogWriter, event));
        const acceptedState = "accepted" satisfies ProposalResolutionState;
        const result =
          reviewerIdentity === undefined
            ? ctx.updatePendingResolutionStatement.run(
                acceptedState,
                parsedUpdatedAt,
                parsedProposalId
              )
            : ctx.updatePendingResolutionWithIdentityStatement.run(
                acceptedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw ctx.createPendingResolutionFailure(parsedProposalId);
        }

        const capsule = parsedSynthesisCreate.capsule;
        const synthesisEvent = insertEventLogEntry(ctx.eventLogWriter, {
          event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
          entity_type: "synthesis_capsule",
          entity_id: capsule.object_id,
          workspace_id: capsule.workspace_id,
          run_id: capsule.run_id,
          caused_by: capsule.created_by,
          payload_json: SoulSynthesisCreatedPayloadSchema.parse({
            object_id: capsule.object_id,
            object_kind: capsule.object_kind,
            workspace_id: capsule.workspace_id,
            run_id: capsule.run_id
          })
        });
        ctx.createSynthesisCapsuleStatement.run(
          capsule.object_id,
          capsule.object_kind,
          capsule.schema_version,
          capsule.lifecycle_state,
          capsule.created_at,
          capsule.updated_at,
          capsule.created_by,
          capsule.topic_key,
          capsule.synthesis_type,
          capsule.summary,
          JSON.stringify(capsule.evidence_refs),
          JSON.stringify(capsule.source_memory_refs),
          capsule.workspace_id,
          capsule.run_id,
          capsule.synthesis_status
        );

        const updatedProposalRow = ctx.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (updatedProposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(updatedProposalRow),
          synthesis: capsule,
          events: [...storedReviewEvents, synthesisEvent]
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to accept proposal ${parsedProposalId} with durable synthesis create.`,
        error
      );
    }
  }

function upsertStrictlyGovernedPathRelation(
  ctx: SqliteProposalWorkflowContext,
    input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
    proposalRow: ProposalRow
  ): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry | null }> {
    const proposedPathRelation = parseProposedPathRelation(proposalRow.proposed_path_relation);
    const existingRows = ctx.findPathRelationByAnchorMemoryIdStatement.all(
      input.workspace_id,
      input.target_object_id,
      input.target_object_id,
      input.target_object_id,
      input.target_object_id
    ) as ProposalPathRelationRow[];
    const existingRow =
      proposedPathRelation === null
        ? existingRows[0]
        : existingRows.find((row) =>
            pathRelationMatchesProposalPayload(
              parseProposalPathRelationRow(row),
              input.target_object_id,
              proposedPathRelation
            )
          );

    if (existingRow !== undefined) {
      const existing = parseProposalPathRelationRow(existingRow);
      const updated = applyPathRelationProposal(existing, input, proposedPathRelation);
      const result = ctx.updatePathRelationLegitimacyStatement.run(
        JSON.stringify(updated.legitimacy),
        updated.updated_at,
        updated.path_id
      );
      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Path relation ${updated.path_id} was not found.`);
      }
      const pathEvent = insertEventLogEntry(ctx.eventLogWriter, {
        event_type: RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
        entity_type: "path_relation",
        entity_id: updated.path_id,
        workspace_id: updated.workspace_id,
        run_id: proposalRow.run_id,
        caused_by: input.caused_by,
        payload_json: parseRuntimeGovernanceEventPayload(
          RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
          {
            path_id: updated.path_id,
            workspace_id: updated.workspace_id,
            previous_governance_class: existing.legitimacy.governance_class,
            new_governance_class: updated.legitimacy.governance_class,
            previous_evidence_basis: existing.legitimacy.evidence_basis,
            new_evidence_basis: updated.legitimacy.evidence_basis,
            updated_at: updated.updated_at
          }
        ) as unknown as Record<string, unknown>
      });
      return deepFreeze({ pathRelation: updated, event: pathEvent });
    }

    const created =
      proposedPathRelation === null
        ? createStrictlyGovernedPathRelation(input)
        : createPathRelationFromProposalPayload(input, proposedPathRelation);
    const pathEvent = insertEventLogEntry(ctx.eventLogWriter, {
      event_type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      entity_type: "path_relation",
      entity_id: created.path_id,
      workspace_id: created.workspace_id,
      run_id: proposalRow.run_id,
      caused_by: input.caused_by,
      payload_json: parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.PATH_RELATION_CREATED,
        {
          path_id: created.path_id,
          workspace_id: created.workspace_id,
          relation_kind: created.constitution.relation_kind,
          source_anchor_kind: created.anchors.source_anchor.kind,
          target_anchor_kind: created.anchors.target_anchor.kind,
          initial_strength: created.plasticity_state.strength,
          governance_class: created.legitimacy.governance_class,
          created_at: created.created_at
        }
      ) as unknown as Record<string, unknown>
    });
    ctx.createPathRelationStatement.run(
      created.path_id,
      created.workspace_id,
      JSON.stringify(created.anchors),
      JSON.stringify(created.constitution),
      JSON.stringify(created.effect_vector),
      JSON.stringify(created.plasticity_state),
      JSON.stringify(created.lifecycle),
      JSON.stringify(created.legitimacy),
      created.created_at,
      created.updated_at
    );
    return deepFreeze({ pathRelation: created, event: pathEvent });
  }
