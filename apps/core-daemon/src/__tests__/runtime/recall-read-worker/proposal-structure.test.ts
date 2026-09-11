import { describe, expect, it } from "vitest";
import {
  QUERY_PROPOSAL_MAX_AST_DEPTH,
  QUERY_PROPOSAL_MAX_AST_NODES
} from "@do-soul/alaya-protocol";
import { ConditionalFieldRecallWorkerPayloadSchema } from "../../../runtime/recall-read-worker/protocol.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-10T00:00:00.000Z";

describe("worker proposal structural budget", () => {
  it("rejects the same oversize and deep proposal programs as MCP", () => {
    const deep = nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH + 1);
    const wide = bushyProgram(QUERY_PROPOSAL_MAX_AST_NODES + 1);
    expect(ConditionalFieldRecallWorkerPayloadSchema.safeParse(payload(deep)).success).toBe(false);
    expect(ConditionalFieldRecallWorkerPayloadSchema.safeParse(payload(wide)).success).toBe(false);
    expect(ConditionalFieldRecallWorkerPayloadSchema.safeParse(
      payload(nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH))
    ).success).toBe(true);
  });
});

function payload(program: unknown) {
  return {
    workspace_id: "ws",
    query_text: "needle",
    budget: {
      schema_version: 1 as const,
      work_units: 10_000,
      memory_bytes: 1_000_000,
      page_budget: 800,
      finalization_reserve: 100,
      min_envelope: 10
    },
    snapshot_id: DIGEST,
    interpretation_clock: NOW,
    as_of: NOW,
    expires_at: "2027-01-01T00:00:00.000Z",
    lifetime_now: NOW,
    protocol_version: 1 as const,
    supports_source_evidence: true,
    supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    authorized_scopes: null,
    interpretation_proposal: {
      schema_version: 1,
      original_query_digest: DIGEST,
      producer_id: "compiler.ordinary.v1",
      program
    }
  };
}

function nestedClosures(depth: number): unknown {
  let node: unknown = { schema_version: 1, kind: "epsilon" };
  for (let index = 1; index < depth; index += 1) {
    node = {
      schema_version: 1,
      kind: "closure",
      product_state_sufficient: true,
      body: node
    };
  }
  return node;
}

function bushyProgram(nodes: number): unknown {
  if (nodes <= 1) return { schema_version: 1, kind: "epsilon" };
  const fanout = Math.min(1000, nodes - 1);
  const base = Math.floor((nodes - 1) / fanout);
  const extra = (nodes - 1) % fanout;
  const steps: unknown[] = [];
  for (let index = 0; index < fanout; index += 1) {
    steps.push(bushyProgram(base + (index < extra ? 1 : 0)));
  }
  return { schema_version: 1, kind: "sequence", steps };
}
