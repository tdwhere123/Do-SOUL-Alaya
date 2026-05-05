import { describe, expect, it } from "vitest";
import {
  SoulListPendingProposalsRequestSchema,
  SoulListPendingProposalsResponseSchema,
  SoulReviewMemoryProposalRequestSchema,
  soulToolJsonSchemas
} from "../soul/mcp-types.js";

// A1 (HITL daemon backbone) — locks the contract for the new pending-proposals
// listing tool and the reviewer_identity field on the review request schema.
// Schemas are .strict() so unknown fields are rejected, matching the rest of
// the public MCP surface.
describe("soul.list_pending_proposals contract", () => {
  it("parses an empty request (workspace bound server-side per finding-2)", () => {
    // A1 fix-loop (finding-2): workspace_id was dropped from the public
    // request schema to match soul.explore_graph; the daemon binds
    // workspace from the trusted MCP call context (invariants §29).
    expect(SoulListPendingProposalsRequestSchema.parse({})).toEqual({});
  });

  it("parses a request with optional since and limit", () => {
    const request = {
      since: "2026-04-30T00:00:00.000Z",
      limit: 25
    } as const;
    expect(SoulListPendingProposalsRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts a null since explicitly", () => {
    const request = { since: null } as const;
    expect(SoulListPendingProposalsRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a workspace_id field (locked out by finding-2 fix)", () => {
    // strict() — workspace_id is not declared on the schema, so a
    // payload that tries to redirect the listing to a foreign workspace
    // is rejected at parse time, not just at runtime.
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({ workspace_id: "ws-foreign" })
    ).toThrow();
  });

  it("rejects a non-iso since string", () => {
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({
        since: "not-a-date"
      })
    ).toThrow();
  });

  it("rejects an out-of-range limit", () => {
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({ limit: 0 })
    ).toThrow();
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({ limit: 101 })
    ).toThrow();
  });

  it("rejects unknown request fields (strict)", () => {
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({
        rogue_field: "x"
      })
    ).toThrow();
  });

  it("parses a response with proposals and total count", () => {
    const response = {
      proposals: [
        {
          proposal_id: "prop-1",
          target_object_id: "mem-1",
          target_object_kind: "memory_entry",
          created_at: "2026-04-30T00:00:00.000Z",
          proposed_change_summary: "Switch from npm to pnpm."
        }
      ],
      total_count: 1
    } as const;
    expect(SoulListPendingProposalsResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects unknown proposal-summary fields (strict)", () => {
    expect(() =>
      SoulListPendingProposalsResponseSchema.parse({
        proposals: [
          {
            proposal_id: "prop-1",
            target_object_id: "mem-1",
            target_object_kind: "memory_entry",
            created_at: "2026-04-30T00:00:00.000Z",
            proposed_change_summary: "Switch from npm to pnpm.",
            secret_field: "leak"
          }
        ],
        total_count: 1
      })
    ).toThrow();
  });
});

describe("soul.review_memory_proposal reviewer_identity contract", () => {
  it("parses a review request with reviewer_identity", () => {
    const request = {
      proposal_id: "prop-1",
      verdict: "accept",
      reason: "Confirmed by reviewer.",
      reviewer_identity: "user:alice"
    } as const;
    expect(SoulReviewMemoryProposalRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a review request missing reviewer_identity", () => {
    expect(() =>
      SoulReviewMemoryProposalRequestSchema.parse({
        proposal_id: "prop-1",
        verdict: "accept",
        reason: null
      })
    ).toThrow();
  });

  it("rejects an empty reviewer_identity", () => {
    expect(() =>
      SoulReviewMemoryProposalRequestSchema.parse({
        proposal_id: "prop-1",
        verdict: "reject",
        reason: null,
        reviewer_identity: ""
      })
    ).toThrow();
  });
});

describe("soulToolJsonSchemas registration", () => {
  it("registers soul.list_pending_proposals in the public catalog", () => {
    // p5-system-review-r3 MR-I04: external MCP clients see the same bounds
    // the runtime enforces; A1 closes the missing pending-proposals query
    // surface that previously required side-channel inspection.
    expect(soulToolJsonSchemas["soul.list_pending_proposals"]).toBeDefined();
  });
});
