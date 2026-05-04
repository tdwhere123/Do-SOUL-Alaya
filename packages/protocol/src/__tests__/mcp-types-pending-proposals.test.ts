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
  it("parses a minimal request with only workspace_id", () => {
    const request = { workspace_id: "workspace-1" } as const;
    expect(SoulListPendingProposalsRequestSchema.parse(request)).toEqual(request);
  });

  it("parses a request with optional since and limit", () => {
    const request = {
      workspace_id: "workspace-1",
      since: "2026-04-30T00:00:00.000Z",
      limit: 25
    } as const;
    expect(SoulListPendingProposalsRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts a null since explicitly", () => {
    const request = { workspace_id: "workspace-1", since: null } as const;
    expect(SoulListPendingProposalsRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a missing workspace_id", () => {
    expect(() => SoulListPendingProposalsRequestSchema.parse({})).toThrow();
  });

  it("rejects a non-iso since string", () => {
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({
        workspace_id: "workspace-1",
        since: "not-a-date"
      })
    ).toThrow();
  });

  it("rejects an out-of-range limit", () => {
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({ workspace_id: "workspace-1", limit: 0 })
    ).toThrow();
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({ workspace_id: "workspace-1", limit: 101 })
    ).toThrow();
  });

  it("rejects unknown request fields (strict)", () => {
    expect(() =>
      SoulListPendingProposalsRequestSchema.parse({
        workspace_id: "workspace-1",
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
