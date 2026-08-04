import { createHash } from "node:crypto";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { collectRecallEvidenceContexts } from
  "../../recall/supplements/evidence/evidence-contexts.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const ASSERTION = "I bought my bookshelf from IKEA.";
const GIST = `User: ${ASSERTION}`;

describe("recall evidence contexts for associative fact keys", () => {
  it("feeds one source-qualified fact-key field to semantic scoring", async () => {
    const entry = createMemoryEntry({
      content: ASSERTION,
      evidence_refs: ["evidence-1"]
    });
    const evidence = createVerifiedAssertionEvidence();
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [evidence]),
          findRecallQualifiedFactKeysByIds: vi.fn(async () => [{
            capsule: evidence,
            verified_user_projection: false,
            matched_fact_key_forms: [{
              kind: "leave_one_slot_out",
              omitted_slot: { slot_index: 2, role: "value" }
            }],
            matched_projection: {
              projection_id: 5,
              projection_kind: "fact_key",
              content: "I bought my bookshelf"
            }
          }])
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [entry],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {}
    });

    expect(contexts.evidenceSemanticDocumentsByMemoryId[entry.object_id]).toEqual([
      {
        evidenceRef: "evidence-1",
        documentIdentity: "fact_key:5",
        content: "I bought my bookshelf",
        projection: {
          projection_id: 5,
          projection_kind: "fact_key",
          matched_fact_key_forms: [{
            kind: "leave_one_slot_out",
            omitted_slot: { slot_index: 2, role: "value" }
          }]
        }
      }
    ]);
  });
});

function createVerifiedAssertionEvidence(): EvidenceCapsule {
  const sourceHash = formatVerifiedUserAssertionSourceHash(createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source_assertion: ASSERTION,
      source_corpus: GIST
    }), "utf8")
    .digest("hex"));
  return {
    object_id: "evidence-1",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "bookshelf", keywords: [], summary: ASSERTION },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: GIST,
    excerpt: ASSERTION,
    source_hash: sourceHash,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}
