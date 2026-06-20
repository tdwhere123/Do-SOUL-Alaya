import {
  canonicalGovernanceSubject,
  type ToolGovernanceDecision,
  type ToolGovernancePort,
  type ToolGovernanceQuery
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolGovernanceClient } from "../../ports/tool-governance-client.js";

function createQuery(overrides: Partial<ToolGovernanceQuery> = {}): ToolGovernanceQuery {
  return {
    governance_subject: canonicalGovernanceSubject("tooling.policy", { project: "alpha", mode: "safe" }),
    tool_category: "read",
    scope_guard: "project",
    target_surface: "surface://task/default",
    target_paths: ["/workspace/src"],
    destructive: false,
    requested_by: "principal",
    request_context: {
      node_template: "build",
      execution_stance_ref: "stance-default",
      project_ref: "project-alpha"
    },
    ...overrides
  };
}

function createDecision(overrides: Partial<ToolGovernanceDecision> = {}): ToolGovernanceDecision {
  return {
    final_result: "allow",
    matched_claim_refs: [],
    matched_slot_refs: [],
    hard_constraints_present: false,
    requires_red_card: false,
    explanation_summary: "governance allows this tool request",
    ...overrides
  };
}

function createPortMock(
  implementation?: (query: ToolGovernanceQuery) => Promise<ToolGovernanceDecision>
): ToolGovernancePort & { readonly querySpy: ReturnType<typeof vi.fn> } {
  const querySpy = vi.fn(
    implementation ??
      (async () => {
        return createDecision();
      })
  );

  return {
    kind: "test-governance-port",
    queryToolGovernance: querySpy,
    querySpy
  };
}

describe("ToolGovernanceClient", () => {
  it("caches successful results for semantically identical queries within the same node bucket", async () => {
    const port = createPortMock();
    const client = new ToolGovernanceClient({ port });
    const firstQuery = createQuery();
    const secondQuery = {
      requested_by: "principal",
      destructive: false,
      scope_guard: "project",
      governance_subject: {
        subject_qualifiers: { mode: "safe", project: "alpha" },
        canonical_key: "tooling.policy::mode=safe,project=alpha",
        subject_domain: "tooling.policy"
      },
      tool_category: "read",
      request_context: {
        project_ref: "project-alpha",
        execution_stance_ref: "stance-default",
        node_template: "build"
      },
      target_surface: "surface://task/default",
      target_paths: ["/workspace/src"]
    } satisfies ToolGovernanceQuery;

    const first = await client.query(firstQuery, "node-a");
    const second = await client.query(secondQuery, "node-a");

    expect(first).toBe(second);
    expect(port.querySpy).toHaveBeenCalledTimes(1);
  });

  it("deep-freezes cached decisions before returning them", async () => {
    const decision = createDecision({
      matched_claim_refs: ["claim-1"],
      matched_slot_refs: ["slot-1"]
    });
    const port = createPortMock(async () => decision);
    const client = new ToolGovernanceClient({ port });

    const cached = await client.query(createQuery(), "node-a");

    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached.matched_claim_refs)).toBe(true);
    expect(Object.isFrozen(cached.matched_slot_refs)).toBe(true);
    expect(() => {
      (cached.matched_claim_refs as string[]).push("claim-2");
    }).toThrow(TypeError);
    expect(cached.matched_claim_refs).toEqual(["claim-1"]);
  });

  it("isolates caches per node id", async () => {
    const port = createPortMock();
    const client = new ToolGovernanceClient({ port });
    const query = createQuery();

    await client.query(query, "node-a");
    await client.query(query, "node-b");

    expect(port.querySpy).toHaveBeenCalledTimes(2);
  });

  it("uses a dedicated _global bucket when nodeId is omitted", async () => {
    const port = createPortMock();
    const client = new ToolGovernanceClient({ port });
    const query = createQuery();

    await client.query(query);
    await client.query(query);
    await client.query(query, "node-a");

    expect(port.querySpy).toHaveBeenCalledTimes(2);
  });

  it("invalidates one node bucket without affecting others", async () => {
    const port = createPortMock();
    const client = new ToolGovernanceClient({ port });
    const query = createQuery();

    await client.query(query, "node-a");
    await client.query(query, "node-b");
    client.invalidateNode("node-a");
    await client.query(query, "node-a");
    await client.query(query, "node-b");

    expect(port.querySpy).toHaveBeenCalledTimes(3);
  });

  it("invalidates all cached decisions", async () => {
    const port = createPortMock();
    const client = new ToolGovernanceClient({ port });
    const query = createQuery();

    await client.query(query, "node-a");
    await client.query(query);
    client.invalidateAll();
    await client.query(query, "node-a");
    await client.query(query);

    expect(port.querySpy).toHaveBeenCalledTimes(4);
  });

  it("does not poison the cache when the port throws", async () => {
    const decision = createDecision();
    let attempts = 0;
    const port = createPortMock(async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("transient registry failure");
      }

      return decision;
    });
    const client = new ToolGovernanceClient({ port });
    const query = createQuery();

    await expect(client.query(query, "node-a")).rejects.toThrow("transient registry failure");
    await expect(client.query(query, "node-a")).resolves.toEqual(decision);

    expect(port.querySpy).toHaveBeenCalledTimes(2);
  });

  it("expires cached decisions after ttlMs elapses", async () => {
    let nowMs = 1_000;
    const port = createPortMock();
    const client = new ToolGovernanceClient({
      port,
      ttlMs: 50,
      now: () => nowMs
    });
    const query = createQuery();

    await client.query(query, "node-a");
    nowMs = 1_049;
    await client.query(query, "node-a");
    nowMs = 1_051;
    await client.query(query, "node-a");

    expect(port.querySpy).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used cache entry when maxEntries is exceeded", async () => {
    const port = createPortMock();
    const client = new ToolGovernanceClient({
      port,
      maxEntries: 2
    });

    await client.query(createQuery({ target_surface: "surface://task/first" }), "node-a");
    await client.query(createQuery({ target_surface: "surface://task/second" }), "node-b");
    await client.query(createQuery({ target_surface: "surface://task/first" }), "node-a");
    await client.query(createQuery({ target_surface: "surface://task/third" }), "node-c");
    await client.query(createQuery({ target_surface: "surface://task/second" }), "node-b");

    expect(port.querySpy).toHaveBeenCalledTimes(4);
  });
});
