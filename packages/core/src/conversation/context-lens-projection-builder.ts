import {
  ControlPlaneObjectKind,
  ObjectKind,
  RetentionPolicy,
  ScopeClass,
  WorkingProjectionSchema,
  type ClaimForm,
  type ContextLens,
  type ContextLensEntry,
  type MemoryEntry,
  type SessionOverride,
  type TaskObjectSurface,
  type WorkingProjection
} from "@do-soul/alaya-protocol";

import type { RecallCandidate, RecallResult } from "../recall/recall-service.js";
import { makeTokenEstimator, type TokenEstimator } from "../recall/recall-service-types.js";

import {
  compareRecallCandidates,
  createExcerptContent,
  createLensEntry
} from "./context-lens-assembler-ports.js";

export interface ContextLensProjectionBuilderDependencies {
  readonly generateRuntimeId: () => string;
}

export class ContextLensProjectionBuilder {
  private readonly generateRuntimeId: () => string;

  public constructor(dependencies: ContextLensProjectionBuilderDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId;
  }

  public buildLensEntries(
    taskSurface: Readonly<TaskObjectSurface>,
    recallResult: RecallResult,
    strictWinners: readonly Readonly<ClaimForm>[],
    recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>,
    activeOverrides: readonly Readonly<SessionOverride>[]
  ): readonly Readonly<ContextLensEntry>[] {
    const overrideEntries = this.buildOverrideEntries(activeOverrides);
    const taskSurfaceEntries = [
      createLensEntry(taskSurface.runtime_id, ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 1, "full_eligible"),
      createLensEntry(taskSurface.runtime_id, ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 0.9, "full_eligible")
    ];
    const strictWinnerEntries = strictWinners.map((claim) =>
      createLensEntry(claim.object_id, ObjectKind.CLAIM_FORM, 1, "full_eligible", {
        scopeClass: claim.scope_class,
        sourceEnforcement: claim.enforcement_level
      })
    );
    const projectCandidates = recallResult.candidates
      .filter((candidate) => candidate.scope_class === ScopeClass.PROJECT)
      .sort(compareRecallCandidates);
    const projectEntries = projectCandidates.map((candidate) =>
      createLensEntry(candidate.object_id, ObjectKind.MEMORY_ENTRY, candidate.relevance_score, candidate.manifestation, {
        scopeClass: candidate.scope_class
      })
    );
    const globalCandidates = recallResult.candidates
      .filter(
        (candidate) =>
          candidate.scope_class === ScopeClass.GLOBAL_DOMAIN || candidate.scope_class === ScopeClass.GLOBAL_CORE
      )
      .sort(compareRecallCandidates);
    const globalEntries = globalCandidates.map((candidate) =>
      createLensEntry(candidate.object_id, ObjectKind.MEMORY_ENTRY, candidate.relevance_score, candidate.manifestation, {
        scopeClass: candidate.scope_class
      })
    );
    const evidenceEntries = [...new Set([...projectCandidates, ...globalCandidates].flatMap((candidate) => {
      const memory = recalledMemories.get(candidate.object_id);
      return memory?.evidence_refs ?? [];
    }))].map((evidenceRef) => createLensEntry(evidenceRef, ObjectKind.EVIDENCE_CAPSULE, 0.25, "hint"));

    return Object.freeze([
      ...overrideEntries,
      ...taskSurfaceEntries,
      ...strictWinnerEntries,
      ...projectEntries,
      ...globalEntries,
      ...evidenceEntries
    ]);
  }

  public buildOverrideEntries(
    activeOverrides: readonly Readonly<SessionOverride>[]
  ): readonly Readonly<ContextLensEntry>[] {
    return Object.freeze(
      activeOverrides.map((override) =>
        createLensEntry(
          override.runtime_id,
          ControlPlaneObjectKind.SESSION_OVERRIDE,
          1,
          "full_eligible"
        )
      )
    );
  }

  public buildWorkingProjection(
    taskSurface: Readonly<TaskObjectSurface>,
    contextLens: Readonly<ContextLens>,
    recallResult: RecallResult,
    strictWinners: readonly Readonly<ClaimForm>[],
    recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>,
    recallPolicyRef: string | null,
    activeOverrides: readonly Readonly<SessionOverride>[],
    tokenEstimator: TokenEstimator = makeTokenEstimator()
  ): Readonly<WorkingProjection> {
    let taskSurfaceEntryIndex = 0;
    const strictWinnerMap = new Map(strictWinners.map((claim) => [claim.object_id, claim] as const));
    const recallCandidateMap = new Map(recallResult.candidates.map((candidate) => [candidate.object_id, candidate] as const));
    const overrideMap = new Map(activeOverrides.map((override) => [override.runtime_id, override] as const));

    const entries = contextLens.lens_entries.map((entry) => {
      const contentSnapshot = this.resolveContentSnapshot(
        entry,
        taskSurface,
        taskSurfaceEntryIndex,
        strictWinnerMap,
        recallCandidateMap,
        recalledMemories,
        overrideMap
      );

      if (entry.object_kind === ControlPlaneObjectKind.TASK_OBJECT_SURFACE) {
        taskSurfaceEntryIndex += 1;
      }

      return {
        object_id: entry.object_id,
        object_kind: entry.object_kind,
        content_snapshot: contentSnapshot,
        token_estimate: tokenEstimator.estimate(contentSnapshot)
      };
    });
    const totalTokenEstimate = entries.reduce((sum, entry) => sum + entry.token_estimate, 0);

    return WorkingProjectionSchema.parse({
      runtime_id: this.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.WORKING_PROJECTION,
      task_surface_ref: taskSurface.runtime_id,
      expires_at: taskSurface.expires_at,
      derived_from: contextLens.runtime_id,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      entries,
      total_token_estimate: totalTokenEstimate,
      recall_policy_ref: recallPolicyRef
    });
  }

  private resolveContentSnapshot(
    entry: Readonly<ContextLensEntry>,
    taskSurface: Readonly<TaskObjectSurface>,
    taskSurfaceEntryIndex: number,
    strictWinnerMap: ReadonlyMap<string, Readonly<ClaimForm>>,
    recallCandidateMap: ReadonlyMap<string, Readonly<RecallCandidate>>,
    recalledMemories: ReadonlyMap<string, Readonly<MemoryEntry>>,
    overrideMap: ReadonlyMap<string, Readonly<SessionOverride>>
  ): string {
    if (entry.object_kind === ControlPlaneObjectKind.SESSION_OVERRIDE) {
      const override = overrideMap.get(entry.object_id);
      return override === undefined
        ? `[session_override: ${entry.object_id}]`
        : `Override ${override.target_object}: ${override.correction}`;
    }

    if (entry.object_kind === ControlPlaneObjectKind.TASK_OBJECT_SURFACE) {
      if (entry.manifestation === "hint") {
        return `[task surface ref: ${taskSurface.runtime_id}]`;
      }

      if (entry.manifestation === "excerpt") {
        return taskSurfaceEntryIndex === 0
          ? `Goal ref: ${taskSurface.display_name}`
          : `Surface ref: ${taskSurface.runtime_id}`;
      }

      return taskSurfaceEntryIndex === 0
        ? `Goal: ${taskSurface.display_name}`
        : `Surface ${taskSurface.surface_kind}: ${taskSurface.display_name}`;
    }

    if (entry.object_kind === ObjectKind.CLAIM_FORM) {
      if (entry.manifestation === "hint") {
        return `[claim ref: ${entry.object_id}]`;
      }

      const proposition = strictWinnerMap.get(entry.object_id)?.proposition_digest ?? `[claim ref: ${entry.object_id}]`;
      return entry.manifestation === "excerpt" ? createExcerptContent(proposition) : proposition;
    }

    if (entry.object_kind === ObjectKind.MEMORY_ENTRY) {
      if (entry.manifestation === "hint") {
        return `[memory ref: ${entry.object_id}]`;
      }

      const memory = recalledMemories.get(entry.object_id);
      if (entry.manifestation === "excerpt") {
        return recallCandidateMap.get(entry.object_id)?.content_preview ?? createExcerptContent(memory?.content ?? `[memory ref: ${entry.object_id}]`);
      }

      if (memory !== undefined) {
        return memory.content;
      }

      return recallCandidateMap.get(entry.object_id)?.content_preview ?? `[memory ref: ${entry.object_id}]`;
    }

    if (entry.object_kind === ObjectKind.EVIDENCE_CAPSULE) {
      return `[evidence ref: ${entry.object_id}]`;
    }

    if (entry.manifestation === "hint") {
      return `[${entry.object_kind} ref: ${entry.object_id}]`;
    }

    return `[${entry.object_kind}: ${entry.object_id}]`;
  }
}
