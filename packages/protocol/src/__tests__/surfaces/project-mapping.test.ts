import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ProjectMappingAnchorSchema,
  ProjectMappingTransitionAction,
  ProjectMappingTransitionActionSchema,
  ProjectMappingState
} from "../../index.js";

const validTimestamp = "2026-03-29T00:00:00.000Z";

const projectMappingAnchorBase = {
  object_id: "d82e1cb2-534f-4953-aecf-b3f8d6d44150",
  object_kind: "project_mapping_anchor",
  schema_version: 1,
  created_at: validTimestamp,
  updated_at: validTimestamp,
  created_by: "user",
  lifecycle_state: "active",
  global_object_id: "global-1",
  project_id: "project-1",
  mapping_state: ProjectMappingState.SUGGESTED,
  workspace_id: "workspace-1",
  accepted_by: null,
  last_transition_at: validTimestamp
} as const;

describe("project mapping protocol", () => {
  it("extends ProjectMappingAnchor with accepted_by and last_transition_at", () => {
    expect(ProjectMappingAnchorSchema.parse(projectMappingAnchorBase)).toEqual(projectMappingAnchorBase);
    expect(ProjectMappingAnchorSchema.safeParse({ ...projectMappingAnchorBase, accepted_by: "review" }).success).toBe(
      true
    );
    expect(ProjectMappingAnchorSchema.safeParse({ ...projectMappingAnchorBase, accepted_by: "invalid" }).success).toBe(
      false
    );
    expect(ProjectMappingAnchorSchema.safeParse({ ...projectMappingAnchorBase, last_transition_at: undefined }).success)
      .toBe(false);
  });

  it("exports AcceptedBy, ConfirmationPolicy, and getConfirmationPolicy", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const AcceptedBy = protocol.AcceptedBy as Record<string, string> | undefined;
    const ConfirmationPolicy = protocol.ConfirmationPolicy as Record<string, string> | undefined;
    const getConfirmationPolicy = protocol.getConfirmationPolicy as
      | ((dimension: string) => string)
      | undefined;

    expect(AcceptedBy).toEqual({
      USER: "user",
      REVIEW: "review",
      DETERMINISTIC_RULE: "deterministic_rule"
    });
    expect(ConfirmationPolicy).toEqual({
      BATCH_RECOMMEND: "batch_recommend",
      PER_ITEM: "per_item",
      STRICT: "strict"
    });
    expect(typeof getConfirmationPolicy).toBe("function");
  });

  it("defines canonical snake_case transition actions for project mapping updates", async () => {
    expect(ProjectMappingTransitionAction).toEqual({
      ACCEPT: "accept",
      REJECT: "reject",
      ADAPT: "adapt",
      NOT_APPLICABLE: "not_applicable",
      PROBATIONARY: "probationary"
    });

    for (const action of Object.values(ProjectMappingTransitionAction)) {
      expect(ProjectMappingTransitionActionSchema.safeParse(action).success).toBe(true);
    }

    expect(ProjectMappingTransitionActionSchema.safeParse("notApplicable").success).toBe(false);

    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    expect(protocol.ProjectMappingTransitionAction).toEqual(ProjectMappingTransitionAction);
  });

  it("maps memory dimensions to confirmation policies", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const ConfirmationPolicy = protocol.ConfirmationPolicy as Record<string, string>;
    const getConfirmationPolicy = protocol.getConfirmationPolicy as (dimension: string) => string;

    expect(getConfirmationPolicy(MemoryDimension.PREFERENCE)).toBe(ConfirmationPolicy.BATCH_RECOMMEND);
    expect(getConfirmationPolicy(MemoryDimension.GLOSSARY)).toBe(ConfirmationPolicy.BATCH_RECOMMEND);
    expect(getConfirmationPolicy(MemoryDimension.HAZARD)).toBe(ConfirmationPolicy.STRICT);

    for (const dimension of [
      MemoryDimension.CONSTRAINT,
      MemoryDimension.DECISION,
      MemoryDimension.PROCEDURE,
      MemoryDimension.FACT,
      MemoryDimension.EPISODE
    ]) {
      expect(getConfirmationPolicy(dimension)).toBe(ConfirmationPolicy.PER_ITEM);
    }
  });
});
