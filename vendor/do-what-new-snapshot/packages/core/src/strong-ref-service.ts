import { randomUUID } from "node:crypto";
import {
  StrongRefReasonSchema,
  StrongRefSchema,
  type StrongRef,
  type StrongRefReason
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface StrongRefRepoPort {
  create(ref: StrongRef): Promise<Readonly<StrongRef>>;
  delete(refId: string): Promise<void>;
  deleteBySource(sourceEntityType: string, sourceEntityId: string): Promise<void>;
  findByTarget(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<readonly Readonly<StrongRef>[]>;
  findByTargets(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<readonly Readonly<StrongRef>[]>;
  findBySource(sourceEntityId: string): Promise<readonly Readonly<StrongRef>[]>;
  isProtected(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<boolean>;
  areAllProtected(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<boolean>;
}

export interface StrongRefServiceDependencies {
  readonly repo: StrongRefRepoPort;
  readonly generateRefId?: () => string;
  readonly now?: () => string;
}

export class StrongRefService {
  private readonly generateRefId: () => string;
  private readonly now: () => string;

  public constructor(private readonly deps: StrongRefServiceDependencies) {
    this.generateRefId = deps.generateRefId ?? (() => randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  public async protect(params: {
    sourceEntityType: string;
    sourceEntityId: string;
    targetEntityType: string;
    targetEntityId: string;
    workspaceId: string;
    reason: StrongRefReason;
  }): Promise<Readonly<StrongRef>> {
    const ref = parseStrongRef({
      ref_id: parseNonEmptyString(this.generateRefId(), "refId"),
      source_entity_type: parseNonEmptyString(params.sourceEntityType, "sourceEntityType"),
      source_entity_id: parseNonEmptyString(params.sourceEntityId, "sourceEntityId"),
      target_entity_type: parseNonEmptyString(params.targetEntityType, "targetEntityType"),
      target_entity_id: parseNonEmptyString(params.targetEntityId, "targetEntityId"),
      workspace_id: parseNonEmptyString(params.workspaceId, "workspaceId"),
      reason: parseStrongRefReason(params.reason),
      created_at: this.now()
    });

    const existingBeforeCreate = await this.findExisting(ref);
    if (existingBeforeCreate !== null) {
      return existingBeforeCreate;
    }

    try {
      return await this.deps.repo.create(ref);
    } catch (error) {
      const existingAfterCreateFailure = await this.findExisting(ref);
      if (existingAfterCreateFailure !== null) {
        return existingAfterCreateFailure;
      }

      throw error;
    }
  }

  public async release(refId: string): Promise<void> {
    await this.deps.repo.delete(parseNonEmptyString(refId, "refId"));
  }

  public async releaseBySource(params: {
    sourceEntityType: string;
    sourceEntityId: string;
  }): Promise<void> {
    await this.deps.repo.deleteBySource(
      parseNonEmptyString(params.sourceEntityType, "sourceEntityType"),
      parseNonEmptyString(params.sourceEntityId, "sourceEntityId")
    );
  }

  public async isProtected(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<boolean> {
    return await this.deps.repo.isProtected(
      parseNonEmptyString(workspaceId, "workspaceId"),
      parseNonEmptyString(targetEntityType, "targetEntityType"),
      parseNonEmptyString(targetEntityId, "targetEntityId")
    );
  }

  public async areAllProtected(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<boolean> {
    return await this.deps.repo.areAllProtected(
      parseNonEmptyString(workspaceId, "workspaceId"),
      parseNonEmptyString(targetEntityType, "targetEntityType"),
      targetEntityIds.map((targetEntityId) => parseNonEmptyString(targetEntityId, "targetEntityId"))
    );
  }

  public async findByTargets(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<readonly Readonly<StrongRef>[]> {
    return await this.deps.repo.findByTargets(
      parseNonEmptyString(workspaceId, "workspaceId"),
      parseNonEmptyString(targetEntityType, "targetEntityType"),
      targetEntityIds.map((targetEntityId) => parseNonEmptyString(targetEntityId, "targetEntityId"))
    );
  }

  private async findExisting(ref: Readonly<StrongRef>): Promise<Readonly<StrongRef> | null> {
    const sourceRefs = await this.deps.repo.findBySource(ref.source_entity_id);
    return (
      sourceRefs.find((candidate) => {
        return (
          candidate.source_entity_type === ref.source_entity_type &&
          candidate.target_entity_type === ref.target_entity_type &&
          candidate.target_entity_id === ref.target_entity_id &&
          candidate.reason === ref.reason
        );
      }) ?? null
    );
  }
}

function parseStrongRefReason(value: StrongRefReason): StrongRefReason {
  try {
    return StrongRefReasonSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "reason must be a supported strong-ref reason", { cause: error });
  }
}

function parseStrongRef(value: StrongRef): Readonly<StrongRef> {
  try {
    return deepFreeze(StrongRefSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid strong-ref payload", { cause: error });
  }
}
