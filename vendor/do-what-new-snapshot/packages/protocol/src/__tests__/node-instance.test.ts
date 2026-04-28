import { describe, expect, it } from "vitest";
import {
  FROZEN_NODE_TEMPLATE_CONTRACTS,
  NodeInstanceSchema,
  NodeInstanceStateSchema,
  NodeTemplateKindSchema
} from "../index.js";

describe("NodeInstance protocol contracts", () => {
  it("parses a valid node instance fixture", () => {
    const fixture = createNodeInstance();

    expect(NodeInstanceSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects node instances that omit node_template", () => {
    const { node_template: _nodeTemplate, ...fixture } = createNodeInstance();

    expect(NodeInstanceSchema.safeParse(fixture).success).toBe(false);
  });

  it("rejects invalid node instance states", () => {
    expect(NodeInstanceStateSchema.safeParse("paused").success).toBe(false);
  });

  it("keeps node template schema values aligned with the frozen contracts", () => {
    expect(NodeTemplateKindSchema.options).toEqual(
      FROZEN_NODE_TEMPLATE_CONTRACTS.map((contract) => contract.node_template)
    );
  });
});

function createNodeInstance() {
  return {
    node_id: "node-1",
    principal_run_id: "run-1",
    node_template: "analyze",
    state: "pending",
    task_surface_ref: "surface://runs/run-1/tasks/1",
    stance_resolution_ref: null,
    created_at: "2026-04-13T10:00:00.000Z",
    updated_at: "2026-04-13T10:00:00.000Z"
  } as const;
}
